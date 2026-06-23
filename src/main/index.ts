import { app, shell, BrowserWindow, ipcMain } from 'electron'
import { join } from 'path'
import os from 'os'
import { existsSync } from 'fs'
import { loadMemory, saveMemory, type MemoryRecord } from './memory'
import { runAgent, getResyncTurn } from './agent'
import { hasApiKey, setApiKey, clearApiKey } from './secrets'
import {
  appendMessage,
  loadRecentMessages,
  appendTerminal,
  loadTerminalScrollback
} from './store'

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
  return runAgent(win, requestId, prompt, ask)
})

// After a renderer reload (e.g. a hot-reload of Artemis's own UI) the new page asks
// the main process whether a turn was in flight, and re-attaches to it.
ipcMain.handle('agent:resync', () => getResyncTurn())

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
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
