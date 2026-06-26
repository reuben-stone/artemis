import {
  app,
  shell,
  BrowserWindow,
  ipcMain,
  session,
  systemPreferences,
  dialog,
  desktopCapturer,
  screen
} from 'electron'
import { join, basename } from 'path'
import os from 'os'
import { existsSync, readFileSync } from 'fs'
import { exec } from 'child_process'
import { promisify } from 'util'
import { loadMemory, saveMemory, type MemoryRecord } from './memory'
import {
  runAgent,
  cancelTurn,
  getResyncTurn,
  resetSession,
  undoSession,
  invalidateSystemCache,
  setSessionTrusted,
  getSessionTrusted,
  type PermissionDecision
} from './agent'
import { buildAppMenu } from './menu'
import { gatherBriefing } from './briefing'
import { hasApiKey, setApiKey, clearApiKey } from './secrets'
import { parseGitRemote } from './github'
import { hasGaCredentials, setGaCredentials, clearGaCredentials } from './ga'
import { syncBoardForProject, syncPrOutcomes, createTicket, listOwnerBoards, getTicketDetail, updateTicket, addTicketComment, editTicketComment, deleteTicketComment } from './board'
import { runWorker } from './worker'
import {
  appendMessage,
  loadRecentMessages,
  appendTerminal,
  loadTerminalScrollback,
  getModel,
  setModel,
  getBackend,
  setBackend,
  getOllamaHost,
  setOllamaHost,
  getOllamaModel,
  setOllamaModel,
  listProjects,
  addProject,
  removeProject,
  getActiveProjectPath,
  setActiveProjectPath,
  ensureSelfProject,
  pruneBundledProjects,
  getProjectGaProps,
  setProjectGaProps,
  type GaProp,
  listPrReviews,
  setPrReviewed,
  clearReviewedPrs,
  listAllTickets,
  listTicketsByProject,
  getProjectBoards,
  setProjectBoards,
  listUnreadComments,
  markCommentsRead,
  type BoardConfig,
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
  getPermissionMode,
  setPermissionMode,
  listAllowedCommands,
  removeAllowedCommand,
  clearAllowedCommands,
  type TodoStatus,
  type PermissionMode
} from './store'

const execp = promisify(exec)

// Read a repo's GitHub remote + current branch/dirty state for the Projects UI.
// Best-effort: a non-git folder just yields nulls.
async function gitInfo(path: string): Promise<{ remote: string | null; branch: string | null; dirty: boolean }> {
  const run = async (cmd: string) => (await execp(cmd, { cwd: path })).stdout.trim()
  let remote: string | null = null
  let branch: string | null = null
  let dirty = false
  try {
    remote = (await run('git config --get remote.origin.url')) || null
  } catch {
    /* no remote */
  }
  try {
    branch = (await run('git rev-parse --abbrev-ref HEAD')) || null
    dirty = (await run('git status --porcelain')).length > 0
  } catch {
    /* not a git repo */
  }
  return { remote, branch, dirty }
}

// A clear registry name: a monorepo subdirectory becomes "repo/subdir" (so a workspace isn't
// an ambiguous bare basename next to its parent); a repo root keeps its folder name.
async function projectDisplayName(path: string): Promise<string> {
  try {
    const prefix = (await execp('git rev-parse --show-prefix', { cwd: path })).stdout.trim().replace(/\/$/, '')
    if (prefix) {
      const top = (await execp('git rev-parse --show-toplevel', { cwd: path })).stdout.trim()
      return `${basename(top)}/${prefix}`
    }
  } catch {
    /* not a git subdir */
  }
  return basename(path)
}

// The registry enriched with live git status + active flag, for the renderer.
async function projectsWithStatus(): Promise<unknown[]> {
  const active = getActiveProjectPath()
  return Promise.all(
    listProjects().map(async (p) => {
      const { branch, dirty } = await gitInfo(p.path)
      return {
        ...p,
        branch,
        dirty,
        active: p.path === active,
        gh: parseGitRemote(p.remote),
        gaProps: getProjectGaProps(p.path),
        boards: getProjectBoards(p.path)
      }
    })
  )
}

// node-pty is a native module; load lazily so a build issue doesn't crash boot.
let pty: typeof import('node-pty') | null = null
try {
  pty = require('node-pty')
} catch (err) {
  console.error('[artemis] node-pty unavailable — terminal disabled:', err)
}

const shellPath =
  process.platform === 'win32' ? 'powershell.exe' : process.env.SHELL || '/bin/zsh'

// Keep the orb's rAF loop alive in every backgrounded/occluded state. The per-window
// `backgroundThrottling: false` covers unfocus but NOT macOS occlusion (window covered
// by another) — Chromium still pauses rAF then, freezing the orb until you click in.
// These app-level switches (set before `ready`) disable that occlusion/timer throttling.
app.commandLine.appendSwitch('disable-renderer-backgrounding')
app.commandLine.appendSwitch('disable-background-timer-throttling')
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows')

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 600,
    show: false,
    backgroundColor: '#05060a',
    titleBarStyle: 'hiddenInset',
    vibrancy: 'under-window',
    webPreferences: {
      preload: join(__dirname, '../preload/index.mjs'),
      sandbox: false,
      // let Artemis speak on launch without requiring a click first
      autoplayPolicy: 'no-user-gesture-required',
      // keep the render loop (orb) alive when the window is unfocused/occluded —
      // otherwise Chromium pauses rAF and the orb freezes until you click in.
      backgroundThrottling: false
    }
  })

  win.on('ready-to-show', () => win.show())

  // Allow microphone capture (voice input, Phase 1); deny other permission requests.
  win.webContents.session.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(permission === 'media')
  })

  win.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  // One PTY per window for the visual-shell slice.
  let ptyProcess: import('node-pty').IPty | null = null

  // Coalesce pty output before persisting — the shell emits many tiny chunks, and
  // one INSERT per chunk would thrash the DB. Flush a batch every 400ms.
  let termBuf = ''
  let termTimer: ReturnType<typeof setTimeout> | null = null
  const flushTerm = () => {
    termTimer = null
    if (!termBuf) return
    appendTerminal(termBuf)
    termBuf = ''
  }

  ipcMain.handle('pty:spawn', (_e, opts: { cols: number; rows: number }) => {
    if (!pty) return { ok: false, reason: 'node-pty unavailable' }
    ptyProcess?.kill()
    ptyProcess = pty.spawn(shellPath, [], {
      name: 'xterm-color',
      cols: opts.cols || 80,
      rows: opts.rows || 24,
      cwd: os.homedir(),
      env: process.env as Record<string, string>
    })
    ptyProcess.onData((data) => {
      if (!win.isDestroyed()) win.webContents.send('pty:data', data)
      termBuf += data
      if (!termTimer) termTimer = setTimeout(flushTerm, 400)
    })
    ptyProcess.onExit(() => {
      if (!win.isDestroyed()) win.webContents.send('pty:exit')
    })
    return { ok: true }
  })

  ipcMain.on('pty:input', (_e, data: string) => ptyProcess?.write(data))
  ipcMain.on('pty:resize', (_e, size: { cols: number; rows: number }) =>
    ptyProcess?.resize(size.cols, size.rows)
  )

  win.on('closed', () => {
    if (termTimer) clearTimeout(termTimer)
    flushTerm()
    ptyProcess?.kill()
  })

  if (process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

// Persistent memory IPC — available to every window.
ipcMain.handle('memory:load', () => loadMemory())
ipcMain.handle('memory:save', (_e, rec: MemoryRecord) => saveMemory(rec))

// Durable transcript + terminal scrollback (SQLite backbone).
ipcMain.handle('history:load', (_e, limit?: number) => loadRecentMessages(limit ?? 200))
ipcMain.handle('history:append', (_e, { role, text }: { role: 'user' | 'assistant'; text: string }) =>
  appendMessage(role, text)
)
ipcMain.handle('terminal:scrollback', () => loadTerminalScrollback())

// --- Operator (Agent SDK) IPC ---
let permCounter = 0
const pendingPerms = new Map<number, (d: PermissionDecision) => void>()

ipcMain.on(
  'agent:permissionResponse',
  (_e, { permId, decision }: { permId: number; decision: PermissionDecision }) => {
    const resolve = pendingPerms.get(permId)
    if (resolve) {
      pendingPerms.delete(permId)
      resolve(decision)
    }
  }
)

// Permission mode (persisted guarded/smart) + session-only "trusted" + the saved
// command allowlist. The face reads/sets these; the gate in agent.ts consults them.
ipcMain.handle('permissions:get', () => ({ mode: getPermissionMode(), trusted: getSessionTrusted() }))
ipcMain.handle('permissions:setMode', (_e, mode: PermissionMode) => {
  setPermissionMode(mode)
  return { mode: getPermissionMode(), trusted: getSessionTrusted() }
})
ipcMain.handle('permissions:setTrusted', (_e, trusted: boolean) => {
  setSessionTrusted(!!trusted)
  return { mode: getPermissionMode(), trusted: getSessionTrusted() }
})
ipcMain.handle('permissions:listAllowed', () => listAllowedCommands())
ipcMain.handle('permissions:removeAllowed', (_e, id: number) => {
  removeAllowedCommand(id)
  return listAllowedCommands()
})
ipcMain.handle('permissions:clearAllowed', () => {
  clearAllowedCommands()
  return listAllowedCommands()
})

ipcMain.handle(
  'agent:run',
  (
    e,
    {
      requestId,
      prompt,
      media
    }: {
      requestId: string
      prompt: string
      media?: { kind: 'image' | 'document'; mediaType: string; data: string }[]
    }
  ) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    if (!win) return
  const ask = (req: { toolName: string; input: unknown }) =>
    new Promise<PermissionDecision>((resolve) => {
      const permId = ++permCounter
      pendingPerms.set(permId, resolve)
      win.webContents.send('agent:permission', { permId, ...req })
    })
  // Electron transport adapter: forward agent events to the renderer. A future
  // sidecar daemon supplies a different emit (socket) — runAgent is unchanged.
  const emit = (event: Record<string, unknown>): void => {
    if (!win.isDestroyed()) win.webContents.send('agent:event', event)
  }
    return runAgent(emit, requestId, prompt, ask, media)
  }
)

// Stop an in-flight turn (Esc / Stop button) — aborts the model stream + tool loop.
ipcMain.on('agent:cancel', (_e, requestId: string) => cancelTurn(requestId))

// ─── Screen capture (a Sense Claude Code can't have) ───────────────────────
// macOS gates screen capture behind Screen Recording permission; it can't be granted
// programmatically and only takes effect after an app restart once toggled in Settings.
ipcMain.handle('screen:status', () =>
  process.platform === 'darwin' ? systemPreferences.getMediaAccessStatus('screen') : 'granted'
)
ipcMain.handle('screen:openPrivacy', () =>
  shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture')
)
// Small thumbnails for the source picker.
ipcMain.handle('screen:sources', async () => {
  const sources = await desktopCapturer.getSources({
    types: ['screen', 'window'],
    thumbnailSize: { width: 320, height: 200 }
  })
  return sources.map((s) => ({ id: s.id, name: s.name, thumbnail: s.thumbnail.toDataURL() }))
})
// Full-res still of the chosen source, returned as a PNG data URL. Returns a structured
// { error } instead of a bare null on failure, so the picker can say *why* rather than
// silently doing nothing.
ipcMain.handle('screen:capture', async (_e, sourceId: string) => {
  try {
    // Only enumerate the kind we actually picked (faster, and avoids grabbing every
    // window at full res when the user chose a screen).
    const types: ('screen' | 'window')[] = sourceId.startsWith('window:') ? ['window'] : ['screen']
    // Size the grab to the largest display's real pixel resolution. A fixed box that's
    // smaller than the screen downscales; one that mismatches the aspect/scale can come
    // back as an empty (black) NativeImage on Retina/scaled Macs — the silent-null bug.
    const px = screen.getAllDisplays().reduce(
      (max, d) => {
        const w = Math.round(d.size.width * d.scaleFactor)
        const h = Math.round(d.size.height * d.scaleFactor)
        return w * h > max.width * max.height ? { width: w, height: h } : max
      },
      { width: 1920, height: 1200 }
    )
    const sources = await desktopCapturer.getSources({ types, thumbnailSize: px })
    const src = sources.find((s) => s.id === sourceId) ?? sources[0]
    if (!src) return { error: 'That screen is no longer available — reopen the picker and try again.' }
    if (src.thumbnail.isEmpty()) {
      return {
        error:
          'Capture came back empty — Screen Recording permission may not be fully granted for this app. Toggle it in System Settings and relaunch.'
      }
    }
    return { dataUrl: src.thumbnail.toDataURL(), mediaType: 'image/png', name: `${src.name}.png` }
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'Screen capture failed.' }
  }
})

// After a renderer reload (e.g. a hot-reload of Artemis's own UI) the new page asks
// the main process whether a turn was in flight, and re-attaches to it.
ipcMain.handle('agent:resync', () => getResyncTurn())

// "New conversation": drop the session (fresh context) and archive the visible
// thread by raising the view floor (resetSession does both). History stays in the DB.
ipcMain.handle('agent:newConversation', async () => {
  await resetSession()
})
// Reversible: un-archive the prior thread (restores the previous view floor).
ipcMain.handle('agent:undoNewConversation', async () => {
  await undoSession()
})

// Model preference (Sonnet default, switchable to Opus).
ipcMain.handle('agent:getModel', () => getModel())
ipcMain.handle('agent:setModel', (_e, model: string) => setModel(model))

// Backend preference: which brain runs the turn (anthropic API / local ollama /
// claude-cli subscription). Host/model for ollama point at laptop or a brain box.
ipcMain.handle('agent:getBackendConfig', () => ({
  backend: getBackend(),
  ollamaHost: getOllamaHost(),
  ollamaModel: getOllamaModel()
}))
ipcMain.handle(
  'agent:setBackendConfig',
  (_e, cfg: { backend?: string; ollamaHost?: string; ollamaModel?: string }) => {
    if (cfg.backend != null) setBackend(cfg.backend)
    if (cfg.ollamaHost != null) setOllamaHost(cfg.ollamaHost)
    if (cfg.ollamaModel != null) setOllamaModel(cfg.ollamaModel)
  }
)

// --- Projects (multi-project foundation) IPC ---
ipcMain.handle('projects:list', () => projectsWithStatus())

// Open a native folder picker (multi-select) and register each chosen folder,
// auto-detecting its GitHub remote from `origin`.
ipcMain.handle('projects:add', async (e) => {
  const win = BrowserWindow.fromWebContents(e.sender)
  const res = await dialog.showOpenDialog(win!, {
    title: 'Add project folder(s)',
    properties: ['openDirectory', 'multiSelections', 'createDirectory']
  })
  if (!res.canceled) {
    for (const path of res.filePaths) {
      const { remote } = await gitInfo(path)
      addProject(await projectDisplayName(path), path, remote)
    }
  }
  return projectsWithStatus()
})

ipcMain.handle('projects:remove', (_e, id: number) => {
  removeProject(id)
  invalidateSystemCache()
  return projectsWithStatus()
})

ipcMain.handle('projects:setActive', (_e, path: string) => {
  setActiveProjectPath(path)
  invalidateSystemCache() // the active project is baked into the system prompt
  return projectsWithStatus()
})

ipcMain.handle('projects:setGaProps', (_e, { path, props }: { path: string; props: GaProp[] }) => {
  setProjectGaProps(path, props)
  return projectsWithStatus()
})

// --- Connections / onboarding IPC ---
ipcMain.handle('connections:status', async () => {
  let githubUser: string | null = null
  try {
    githubUser = (await execp('gh api user --jq .login')).stdout.trim() || null
  } catch {
    githubUser = null
  }
  return {
    anthropic: await hasApiKey(),
    github: { connected: !!githubUser, user: githubUser },
    ga: { configured: hasGaCredentials() }
  }
})

// Pick a GA4 service-account JSON file and store it encrypted.
ipcMain.handle('connections:setGaCredentials', async (e) => {
  const win = BrowserWindow.fromWebContents(e.sender)
  const res = await dialog.showOpenDialog(win!, {
    title: 'Select your GA4 service-account JSON key',
    properties: ['openFile'],
    filters: [{ name: 'JSON', extensions: ['json'] }]
  })
  if (res.canceled || !res.filePaths[0]) return { ok: false, configured: hasGaCredentials() }
  try {
    await setGaCredentials(readFileSync(res.filePaths[0], 'utf8'))
    return { ok: true, configured: true }
  } catch (err: unknown) {
    return { ok: false, configured: hasGaCredentials(), error: err instanceof Error ? err.message : String(err) }
  }
})

ipcMain.handle('connections:clearGaCredentials', async () => {
  await clearGaCredentials()
  return { configured: false }
})

// Does the gh token carry the Projects v2 scope? A trivial projectsV2 query fails without it,
// so this is a reliable probe for the "needs gh auth refresh -s project" onboarding hint.
ipcMain.handle('connections:checkProjectScope', async () => {
  try {
    await execp(`gh api graphql -f query='query{viewer{projectsV2(first:1){totalCount}}}'`)
    return true
  } catch {
    return false
  }
})

// --- Briefing (on-command, structured data → docked card) ---
ipcMain.handle('briefing:data', () => gatherBriefing())

// --- PR Review Queue IPC (worker-agent output, human approval) ---
ipcMain.handle('prReviews:list', () => listPrReviews())
ipcMain.handle('prReviews:setReviewed', (_e, { id, reviewed }: { id: number; reviewed: boolean }) => {
  setPrReviewed(id, reviewed)
  return listPrReviews()
})
ipcMain.handle('prReviews:clearReviewed', () => {
  clearReviewedPrs()
  return listPrReviews()
})
// Pull live merge/CI/review outcomes from GitHub for every pending PR, then return the queue.
ipcMain.handle('prReviews:sync', async () => {
  try {
    await syncPrOutcomes()
  } catch {
    /* best-effort — keep last-known outcomes */
  }
  return listPrReviews()
})

// --- GitHub Projects ticket board IPC (the ticket operator loop) ---
ipcMain.handle('tickets:list', (_e, project?: string) =>
  project ? listTicketsByProject(project) : listAllTickets()
)
// Which board a cached ticket belongs to (match its boardId; fall back to the project's only
// board). Needed for status moves + dispatch scoping now that a project maps to several boards.
function boardForTicket(projectName: string, projectPath: string, number: number, boardId?: string | null): BoardConfig | null {
  const boards = getProjectBoards(projectPath)
  if (!boards.length) return null
  // Prefer the explicit boardId the caller passed (the clicked ticket knows its own board) —
  // matching by number alone is ambiguous when a project has several boards each holding a #n.
  if (boardId) {
    const exact = boards.find((b) => b.boardId === boardId)
    if (exact) return exact
  }
  const t = listTicketsByProject(projectName).find((x) => x.issueNumber === number)
  return boards.find((b) => b.boardId && b.boardId === t?.boardId) ?? (boards.length === 1 ? boards[0] : null)
}

// Re-sync every board mapped to a project (or all projects that have boards) from GitHub.
ipcMain.handle('tickets:sync', async (_e, project?: string) => {
  const targets = listProjects().filter(
    (p) => getProjectBoards(p.path).length > 0 && (!project || p.name === project)
  )
  const errors: string[] = []
  for (const p of targets) {
    try {
      await syncBoardForProject(p.name, p.path)
    } catch (e: unknown) {
      errors.push(`${p.name}: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
  return { tickets: project ? listTicketsByProject(project) : listAllTickets(), errors }
})
ipcMain.handle(
  'tickets:create',
  async (_e, input: { project: string; boardNumber?: number; title: string; body?: string; status?: string }) => {
    const match = listProjects().find((p) => p.name === input.project)
    if (!match) return { ok: false, error: `No project named "${input.project}".` }
    if (!match.remote) return { ok: false, error: `Project "${match.name}" has no GitHub remote.` }
    const boards = getProjectBoards(match.path)
    // Which board to file onto: the one chosen, else the project's only board (if exactly one).
    const board = boards.find((b) => b.number === input.boardNumber) ?? (boards.length === 1 ? boards[0] : null)
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
      return { ok: true, ...res }
    } catch (e: unknown) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  }
)
// Full detail for one ticket (incl. body). `repo` is the ISSUE's own repo (a board can hold
// issues from a repo that isn't the project's), so fetch from THERE — not the project's remote.
ipcMain.handle('tickets:detail', async (_e, input: { project: string; repo?: string | null; number: number }) => {
  const match = listProjects().find((p) => p.name === input.project)
  const slug = input.repo || (match ? parseGitRemote(match.remote)?.slug : null)
  if (!slug) return { ok: false, error: 'No GitHub repo for this ticket.' }
  try {
    return { ok: true, detail: await getTicketDetail(slug, input.number) }
  } catch (e: unknown) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
})
// Update a ticket from inside Artemis (title/body/state/status). The Save click is the gate.
ipcMain.handle(
  'tickets:update',
  async (
    _e,
    input: {
      project: string
      repo?: string | null // the issue's own repo
      number: number
      itemId?: string | null
      boardId?: string | null // the ticket's board (disambiguates when a project has several)
      patch: { title?: string; body?: string; state?: 'open' | 'closed'; status?: string }
    }
  ) => {
    const match = listProjects().find((p) => p.name === input.project)
    if (!match) return { ok: false, error: `No project named "${input.project}".` }
    try {
      await updateTicket({
        projectName: match.name,
        projectPath: match.path,
        repo: input.repo || parseGitRemote(match.remote)?.slug || null,
        board: boardForTicket(match.name, match.path, input.number, input.boardId),
        number: input.number,
        itemId: input.itemId,
        patch: input.patch
      })
      return { ok: true, tickets: listAllTickets() }
    } catch (e: unknown) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  }
)
// Post a comment on a ticket — the Comment click is the human gate. Returns refreshed detail.
ipcMain.handle('tickets:comment', async (_e, input: { project: string; repo?: string | null; number: number; body: string }) => {
  const match = listProjects().find((p) => p.name === input.project)
  const slug = input.repo || (match ? parseGitRemote(match.remote)?.slug : null)
  if (!slug) return { ok: false, error: 'No GitHub repo for this ticket.' }
  try {
    return { ok: true, detail: await addTicketComment(slug, input.number, input.body) }
  } catch (e: unknown) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
})
// Edit one of your own comments (the Save click is the gate). Returns the refreshed thread.
ipcMain.handle(
  'tickets:editComment',
  async (_e, input: { project: string; repo?: string | null; number: number; commentId: string; body: string }) => {
    const match = listProjects().find((p) => p.name === input.project)
    const slug = input.repo || (match ? parseGitRemote(match.remote)?.slug : null)
    if (!slug) return { ok: false, error: 'No GitHub repo for this ticket.' }
    try {
      return { ok: true, detail: await editTicketComment(slug, input.number, input.commentId, input.body) }
    } catch (e: unknown) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  }
)
// Delete one of your own comments (the confirm is the gate). Returns the refreshed thread.
ipcMain.handle(
  'tickets:deleteComment',
  async (_e, input: { project: string; repo?: string | null; number: number; commentId: string }) => {
    const match = listProjects().find((p) => p.name === input.project)
    const slug = input.repo || (match ? parseGitRemote(match.remote)?.slug : null)
    if (!slug) return { ok: false, error: 'No GitHub repo for this ticket.' }
    try {
      return { ok: true, detail: await deleteTicketComment(slug, input.number, input.commentId) }
    } catch (e: unknown) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  }
)
// Dispatch a worker FROM a board ticket — the click in the board UI is the human gate.
ipcMain.handle(
  'tickets:dispatch',
  async (
    _e,
    input: { project: string; ticketNumber?: number; ticketRepo?: string | null; ticketUrl?: string; boardId?: string | null; task: string; title?: string }
  ) => {
    const match = listProjects().find((p) => p.name === input.project)
    if (!match) return { ok: false, error: `No project named "${input.project}".` }
    // The board the ticket is on may scope the worker to a monorepo subdir (full-repo access,
    // subdir focus). Resolve it from the ticket's board (boardId disambiguates multi-board projects).
    const subdir = input.ticketNumber != null ? boardForTicket(match.name, match.path, input.ticketNumber, input.boardId)?.subdir : undefined
    return runWorker({
      projectName: match.name,
      projectPath: match.path,
      remote: match.remote,
      task: input.task,
      title: input.title,
      label: 'worker',
      ticketNumber: input.ticketNumber,
      ticketRepo: input.ticketRepo,
      ticketUrl: input.ticketUrl,
      subdir
    })
  }
)
// Ticket-comment notifications — new comments on watched boards (cached during board sync).
ipcMain.handle('notifications:list', () => listUnreadComments())
ipcMain.handle('notifications:markRead', (_e, project?: string) => {
  markCommentsRead(project)
  return listUnreadComments()
})
// List an owner's Projects v2 boards for the no-guesswork picker (also reports org vs user).
ipcMain.handle('board:listBoards', async (_e, owner: string) => {
  try {
    return { ok: true, ...(await listOwnerBoards(owner)) }
  } catch (e: unknown) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
})
// Per-project board list (each: owner / org|user / number / subdir), edited in Settings → Connections.
ipcMain.handle('board:getBoards', (_e, path: string) => getProjectBoards(path))
ipcMain.handle('board:setBoards', (_e, { path, boards }: { path: string; boards: BoardConfig[] }) => {
  setProjectBoards(path, boards)
  return projectsWithStatus()
})

// --- Day planner IPC: todos (ticket system) + local calendar ---
// The renderer rail reads/writes here; Artemis writes the same tables via its tools,
// so both stay in sync against one SQLite source of truth.
ipcMain.handle('tasks:list', (_e, day?: string) => listTodos(day || localDay()))
// Unfinished tasks parked on days BEFORE `day` (carry-over candidates) — for the Tasks modal.
ipcMain.handle('tasks:listBefore', (_e, day?: string) => unfinishedBefore(day || localDay()))
ipcMain.handle('tasks:add', (_e, input: { day?: string; text: string; priority?: string; project?: string }) =>
  addTodo({ day: input.day || localDay(), text: input.text, priority: input.priority, project: input.project })
)
ipcMain.handle(
  'tasks:update',
  (_e, { id, patch }: { id: number; patch: { text?: string; status?: TodoStatus; priority?: string; day?: string } }) =>
    updateTodo(id, patch)
)
ipcMain.handle('tasks:remove', (_e, id: number) => removeTodo(id))
ipcMain.handle('tasks:carryOver', (_e, day?: string) => {
  carryOverTodos(day || localDay())
  return listTodos(day || localDay())
})

ipcMain.handle('calendar:list', (_e, { day, days }: { day?: string; days?: number } = {}) => {
  const start = day || localDay()
  if (!days || days <= 1) return listEvents(start)
  const end = localDay(new Date(new Date(`${start}T12:00:00`).getTime() + (days - 1) * 86400000))
  return listEventsRange(start, end)
})
ipcMain.handle(
  'calendar:add',
  (_e, input: { day?: string; title: string; starts?: string | null; ends?: string | null; notes?: string | null }) =>
    addEvent({ ...input, day: input.day || localDay() })
)
ipcMain.handle(
  'calendar:update',
  (
    _e,
    { id, patch }: { id: number; patch: { title?: string; day?: string; starts?: string | null; ends?: string | null; notes?: string | null } }
  ) => updateEvent(id, patch)
)
ipcMain.handle('calendar:remove', (_e, id: number) => removeEvent(id))

// --- Auth IPC ---
ipcMain.handle('auth:status', async () => ({
  hasSubscription: existsSync(join(os.homedir(), '.claude')),
  hasKey: await hasApiKey()
}))
ipcMain.handle('auth:setKey', (_e, key: string) => setApiKey(key))
ipcMain.handle('auth:clearKey', () => clearApiKey())

// Launch-at-login: the OS remembers the login item, so we read/write it directly.
ipcMain.handle('app:getAutoLaunch', () => app.getLoginItemSettings().openAtLogin)
ipcMain.handle('app:setAutoLaunch', (_e, enabled: boolean) => {
  app.setLoginItemSettings({ openAtLogin: enabled, openAsHidden: true })
  return app.getLoginItemSettings().openAtLogin
})

app.whenReady().then(() => {
  // GUI-launched macOS apps inherit a minimal PATH (no /usr/local/bin or
  // /opt/homebrew/bin), so spawned tools (git, gh) wouldn't be found in a packaged
  // build. Ensure the common bin dirs are present for all child processes.
  if (process.platform === 'darwin') {
    const extra = ['/opt/homebrew/bin', '/usr/local/bin']
    const cur = (process.env.PATH || '').split(':').filter(Boolean)
    process.env.PATH = [...new Set([...extra, ...cur])].join(':')
  }

  // Microphone access for voice input (Phase 1): prompt for OS-level access on macOS,
  // and approve in-page media permission checks that getUserMedia consults.
  if (process.platform === 'darwin') {
    systemPreferences.askForMediaAccess('microphone').catch(() => {})
  }
  session.defaultSession.setPermissionCheckHandler((_wc, permission) => permission === 'media')

  pruneBundledProjects() // drop stale "artemis (self)" rows from packaged-bundle paths
  ensureSelfProject() // seed Artemis's own repo so the project switcher is never empty

  buildAppMenu() // real File/Edit/View/Window menus with a working Quit
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
