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
    }
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
