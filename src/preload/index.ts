import { contextBridge, ipcRenderer } from 'electron'

const api = {
  terminal: {
    spawn: (opts: { cols: number; rows: number }) =>
      ipcRenderer.invoke('pty:spawn', opts),
    write: (data: string) => ipcRenderer.send('pty:input', data),
    resize: (size: { cols: number; rows: number }) =>
      ipcRenderer.send('pty:resize', size),
    onData: (cb: (data: string) => void) => {
      const handler = (_e: unknown, data: string) => cb(data)
      ipcRenderer.on('pty:data', handler)
      return () => ipcRenderer.removeListener('pty:data', handler)
    },
    onExit: (cb: () => void) => {
      const handler = () => cb()
      ipcRenderer.on('pty:exit', handler)
      return () => ipcRenderer.removeListener('pty:exit', handler)
    },
    // Persisted scrollback, replayed into a freshly-mounted terminal so history
    // survives a restart.
    scrollback: (): Promise<string> => ipcRenderer.invoke('terminal:scrollback')
  },
  // Durable transcript backbone (SQLite in main). The renderer commits its own
  // messages (user input, greeting, remember-acks); the operator commits assistant
  // replies from main. Both read back here on boot.
  history: {
    load: (limit?: number): Promise<{ role: 'user' | 'assistant'; text: string }[]> =>
      ipcRenderer.invoke('history:load', limit),
    append: (role: 'user' | 'assistant', text: string): Promise<void> =>
      ipcRenderer.invoke('history:append', { role, text })
  },
  memory: {
    load: (): Promise<{ index: string; facts: string[] }> =>
      ipcRenderer.invoke('memory:load'),
    save: (rec: {
      name: string
      description: string
      type: 'user' | 'feedback' | 'project' | 'reference'
      body: string
    }): Promise<{ file: string }> => ipcRenderer.invoke('memory:save', rec)
  },
  app: {
    getAutoLaunch: (): Promise<boolean> => ipcRenderer.invoke('app:getAutoLaunch'),
    setAutoLaunch: (enabled: boolean): Promise<boolean> =>
      ipcRenderer.invoke('app:setAutoLaunch', enabled)
  },
  auth: {
    status: (): Promise<{ hasSubscription: boolean; hasKey: boolean }> =>
      ipcRenderer.invoke('auth:status'),
    setKey: (key: string): Promise<void> => ipcRenderer.invoke('auth:setKey', key),
    clearKey: (): Promise<void> => ipcRenderer.invoke('auth:clearKey')
  },
  agent: {
    run: (requestId: string, prompt: string): Promise<void> =>
      ipcRenderer.invoke('agent:run', { requestId, prompt }),
    // Start a fresh conversation: new SDK context + archived transcript view.
    newConversation: (): Promise<void> => ipcRenderer.invoke('agent:newConversation'),
    // Reverse the last new-conversation: restore the prior thread.
    undoNewConversation: (): Promise<void> => ipcRenderer.invoke('agent:undoNewConversation'),
    getModel: (): Promise<string> => ipcRenderer.invoke('agent:getModel'),
    setModel: (model: string): Promise<void> => ipcRenderer.invoke('agent:setModel', model),
    // Which brain runs turns: 'anthropic' (metered API), 'ollama' (local/box), or
    // 'claude-cli' (flat subscription, not wired yet). Host/model are for ollama.
    getBackendConfig: (): Promise<{
      backend: string
      ollamaHost: string
      ollamaModel: string
    }> => ipcRenderer.invoke('agent:getBackendConfig'),
    setBackendConfig: (cfg: {
      backend?: string
      ollamaHost?: string
      ollamaModel?: string
    }): Promise<void> => ipcRenderer.invoke('agent:setBackendConfig', cfg),
    // Ask main whether a turn was streaming when the renderer reloaded, so the
    // fresh page can re-attach instead of dropping the answer.
    resync: (): Promise<null | {
      requestId: string
      text: string
      done: string | null
      speech: string
      error: string | null
      state: string
    }> => ipcRenderer.invoke('agent:resync'),
    onEvent: (
      cb: (e: {
        requestId: string
        state?: string
        token?: string
        done?: string
        speech?: string
        error?: string
        cost?: number
      }) => void
    ) => {
      const handler = (_e: unknown, payload: any) => cb(payload)
      ipcRenderer.on('agent:event', handler)
      return () => ipcRenderer.removeListener('agent:event', handler)
    },
    onPermission: (
      cb: (req: { permId: number; toolName: string; input: unknown }) => void
    ) => {
      const handler = (_e: unknown, req: any) => cb(req)
      ipcRenderer.on('agent:permission', handler)
      return () => ipcRenderer.removeListener('agent:permission', handler)
    },
    respondPermission: (permId: number, allow: boolean) =>
      ipcRenderer.send('agent:permissionResponse', { permId, allow })
  }
}

contextBridge.exposeInMainWorld('artemis', api)
export type ArtemisAPI = typeof api
