// Minimal Electron stub for the smoke harness — lets main-process modules import
// cleanly under plain Node (vitest) without a real Electron runtime. app paths point
// at a throwaway temp dir so file-backed code (memory store) is side-effect-free.
import os from 'os'
import { join } from 'path'
import { mkdtempSync } from 'fs'

const base = mkdtempSync(join(os.tmpdir(), 'artemis-test-'))

export const app = {
  getPath: (_name?: string) => base,
  getAppPath: () => base,
  getLoginItemSettings: () => ({ openAtLogin: false }),
  setLoginItemSettings: () => {},
  whenReady: async () => {},
  on: () => {},
  quit: () => {}
}

export const safeStorage = {
  isEncryptionAvailable: () => false,
  encryptString: (s: string) => Buffer.from(s, 'utf8'),
  decryptString: (b: Buffer) => b.toString('utf8')
}

export class BrowserWindow {
  webContents = { send: () => {} }
  isDestroyed = () => false
}

export const ipcMain = { handle: () => {}, on: () => {} }
export const systemPreferences = { askForMediaAccess: async () => true }
export const session = { defaultSession: { setPermissionCheckHandler: () => {} } }
export const shell = { openExternal: () => {} }

export default { app, safeStorage, BrowserWindow, ipcMain, systemPreferences, session, shell }
