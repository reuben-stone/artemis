import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'url'
import { dirname, resolve } from 'path'

const root = dirname(fileURLToPath(import.meta.url))

// Smoke harness config. Runs main-process logic under plain Node by aliasing the
// two modules that would otherwise need a real Electron runtime / native ABI.
export default defineConfig({
  resolve: {
    alias: {
      electron: resolve(root, 'test/stubs/electron.ts'),
      'better-sqlite3': resolve(root, 'test/stubs/better-sqlite3.ts')
    }
  },
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts']
  }
})
