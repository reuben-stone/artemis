import { app, shell, BrowserWindow, ipcMain, session, systemPreferences, dialog } from 'electron'
import { join, basename } from 'path'
import os from 'os'
import { existsSync, readFileSync } from 'fs'
import { exec } from 'child_process'
import { promisify } from 'util'
import { loadMemory, saveMemory, type MemoryRecord } from './memory'
import { runAgent, getResyncTurn, resetSession, undoSession, invalidateSystemCache } from './agent'
import { gatherBriefing } from './briefing'
import { hasApiKey, setApiKey, clearApiKey } from './secrets'
import { parseGitRemote } from './github'
import { hasGaCredentials, setGaCredentials, clearGaCredentials } from './ga'
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
  getProjectGaProps,
  setProjectGaProps,
  type GaProp,
  listPrReviews,
  setPrReviewed,
  clearReviewedPrs
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
        gaProps: getProjectGaProps(p.path)
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
      autoplayPolicy: 'no-user-gesture-required'
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
const pendingPerms = new Map<number, (ok: boolean) => void>()

ipcMain.on('agent:permissionResponse', (_e, { permId, allow }: { permId: number; allow: boolean }) => {
  const resolve = pendingPerms.get(permId)
  if (resolve) {
    pendingPerms.delete(permId)
    resolve(!!allow)
  }
})

ipcMain.handle('agent:run', (e, { requestId, prompt }: { requestId: string; prompt: string }) => {
  const win = BrowserWindow.fromWebContents(e.sender)
  if (!win) return
  const ask = (req: { toolName: string; input: unknown }) =>
    new Promise<boolean>((resolve) => {
      const permId = ++permCounter
      pendingPerms.set(permId, resolve)
      win.webContents.send('agent:permission', { permId, ...req })
    })
  // Electron transport adapter: forward agent events to the renderer. A future
  // sidecar daemon supplies a different emit (socket) — runAgent is unchanged.
  const emit = (event: Record<string, unknown>): void => {
    if (!win.isDestroyed()) win.webContents.send('agent:event', event)
  }
  return runAgent(emit, requestId, prompt, ask)
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
      addProject(basename(path), path, remote)
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

  ensureSelfProject() // seed Artemis's own repo so the project switcher is never empty

  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
