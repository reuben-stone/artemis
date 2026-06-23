import { app, safeStorage } from 'electron'
import { join } from 'path'
import { promises as fs } from 'fs'

/**
 * Encrypted storage for Artemis's Anthropic API key.
 *
 * The key is encrypted at rest with Electron `safeStorage` (Keychain on macOS,
 * DPAPI on Windows, libsecret on Linux) and written to userData. It is only ever
 * decrypted in the main process and injected into the Agent SDK subprocess's env —
 * it never reaches the renderer.
 */

const keyFile = () => join(app.getPath('userData'), 'anthropic.key.enc')

export async function hasApiKey(): Promise<boolean> {
  if (process.env.ANTHROPIC_API_KEY) return true
  try {
    await fs.access(keyFile())
    return true
  } catch {
    return false
  }
}

export async function setApiKey(plain: string): Promise<void> {
  const trimmed = plain.trim()
  if (!trimmed) throw new Error('empty key')
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('OS encryption unavailable')
  }
  const enc = safeStorage.encryptString(trimmed)
  await fs.writeFile(keyFile(), enc)
}

export async function getApiKey(): Promise<string | null> {
  if (process.env.ANTHROPIC_API_KEY) return process.env.ANTHROPIC_API_KEY
  try {
    const enc = await fs.readFile(keyFile())
    return safeStorage.decryptString(enc)
  } catch {
    return null
  }
}

export async function clearApiKey(): Promise<void> {
  await fs.rm(keyFile(), { force: true })
}
