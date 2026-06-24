// Stub for the native better-sqlite3 module so importing store.ts under plain Node
// (vitest) doesn't load a binding compiled for Electron's ABI. The smoke harness
// does not exercise the DB, so this only needs to satisfy the import + lazy init.
export default class Database {
  pragma() {}
  exec() {}
  prepare() {
    return {
      get: () => undefined,
      all: () => [],
      run: () => ({ changes: 0 })
    }
  }
}
