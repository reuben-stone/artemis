import { contextBridge, ipcRenderer } from 'electron'

export interface Project {
  id: number
  name: string
  path: string
  remote: string | null
  branch: string | null
  dirty: boolean
  active: boolean
  gh: { slug: string; url: string } | null
  gaProps: GaProp[]
}

export interface GaProp {
  label: string
  id: string
}

export interface BriefingProject {
  name: string
  branch: string | null
  dirty: string[]
  activity7d: number
  lastCommit: string | null
  prs: Array<{ number: number; title: string; agent: boolean }>
  analytics: Array<{
    label: string
    users: number
    newUsers: number
    sessions: number
    views: number
    delta: { users: number | null; sessions: number | null; views: number | null }
  }>
}

export interface BriefingData {
  generatedAt: number
  projects: BriefingProject[]
}

export interface ConnectionsStatus {
  anthropic: boolean
  github: { connected: boolean; user: string | null }
  ga: { configured: boolean }
}

export interface PrReview {
  id: number
  project: string
  title: string
  url: string
  branch: string | null
  agent: string | null
  reviewed: boolean
  created_at: number
}

export type PermissionMode = 'guarded' | 'smart'
export type PermissionDecision = 'deny' | 'once' | 'always'
export interface PermissionState {
  mode: PermissionMode
  trusted: boolean
}
export interface AllowedCommand {
  id: number
  project: string
  command: string
  created_at: number
}

export type TodoStatus = 'todo' | 'doing' | 'done'

export interface Todo {
  id: number
  day: string
  text: string
  status: TodoStatus
  priority: string | null
  project: string | null
  tags: string | null
  position: number
  source: string
  externalId: string | null
  externalUrl: string | null
  carriedFrom: string | null
  created_at: number
}

export interface CalendarEvent {
  id: number
  day: string
  starts: string | null
  ends: string | null
  title: string
  notes: string | null
  source: string
  externalId: string | null
  created_at: number
}

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
  // Multi-project foundation: register/switch the repos Artemis oversees.
  projects: {
    list: (): Promise<Project[]> => ipcRenderer.invoke('projects:list'),
    // Opens a native multi-select folder picker; returns the updated list.
    add: (): Promise<Project[]> => ipcRenderer.invoke('projects:add'),
    remove: (id: number): Promise<Project[]> => ipcRenderer.invoke('projects:remove', id),
    setActive: (path: string): Promise<Project[]> => ipcRenderer.invoke('projects:setActive', path),
    setGaProps: (path: string, props: GaProp[]): Promise<Project[]> =>
      ipcRenderer.invoke('projects:setGaProps', { path, props })
  },
  // Connections / onboarding — status + setup for each integration.
  connections: {
    status: (): Promise<ConnectionsStatus> => ipcRenderer.invoke('connections:status'),
    setGaCredentials: (): Promise<{ ok: boolean; configured: boolean; error?: string }> =>
      ipcRenderer.invoke('connections:setGaCredentials'),
    clearGaCredentials: (): Promise<{ configured: boolean }> =>
      ipcRenderer.invoke('connections:clearGaCredentials')
  },
  // On-command briefing — gather structured ecosystem data for the card.
  briefing: {
    data: (): Promise<BriefingData> => ipcRenderer.invoke('briefing:data')
  },
  // Day planner — the HUD rail's tickets + local calendar. Same SQLite tables Artemis
  // CRUDs via its tools, so the rail and the agent never diverge.
  tasks: {
    list: (day?: string): Promise<Todo[]> => ipcRenderer.invoke('tasks:list', day),
    add: (input: { day?: string; text: string; priority?: string; project?: string }): Promise<Todo> =>
      ipcRenderer.invoke('tasks:add', input),
    update: (
      id: number,
      patch: { text?: string; status?: TodoStatus; priority?: string; day?: string }
    ): Promise<Todo | null> => ipcRenderer.invoke('tasks:update', { id, patch }),
    remove: (id: number): Promise<void> => ipcRenderer.invoke('tasks:remove', id),
    carryOver: (day?: string): Promise<Todo[]> => ipcRenderer.invoke('tasks:carryOver', day)
  },
  calendar: {
    list: (opts?: { day?: string; days?: number }): Promise<CalendarEvent[]> =>
      ipcRenderer.invoke('calendar:list', opts ?? {}),
    add: (input: { day?: string; title: string; starts?: string | null; ends?: string | null; notes?: string | null }): Promise<CalendarEvent> =>
      ipcRenderer.invoke('calendar:add', input),
    update: (
      id: number,
      patch: { title?: string; day?: string; starts?: string | null; ends?: string | null; notes?: string | null }
    ): Promise<CalendarEvent | null> => ipcRenderer.invoke('calendar:update', { id, patch }),
    remove: (id: number): Promise<void> => ipcRenderer.invoke('calendar:remove', id)
  },
  // PR Review Queue — worker-agent PRs awaiting the human's approval.
  prReviews: {
    list: (): Promise<PrReview[]> => ipcRenderer.invoke('prReviews:list'),
    setReviewed: (id: number, reviewed: boolean): Promise<PrReview[]> =>
      ipcRenderer.invoke('prReviews:setReviewed', { id, reviewed }),
    clearReviewed: (): Promise<PrReview[]> => ipcRenderer.invoke('prReviews:clearReviewed')
  },
  agent: {
    run: (
      requestId: string,
      prompt: string,
      media?: { kind: 'image' | 'document'; mediaType: string; data: string }[]
    ): Promise<void> => ipcRenderer.invoke('agent:run', { requestId, prompt, media }),
    // Stop an in-flight turn (Esc / Stop button).
    cancel: (requestId: string): void => ipcRenderer.send('agent:cancel', requestId),
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
        // A tool-call lifecycle event for the chat activity timeline. `phase:'start'`
        // carries name+input; `phase:'end'` carries status+output (preview-clamped).
        tool?: {
          id: string
          phase: 'start' | 'end'
          name?: string
          input?: unknown
          status?: 'ok' | 'error' | 'denied'
          output?: string
        }
        // Agent-driven UI: the agent asked to open a panel in the face.
        ui?: { panel: string }
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
    respondPermission: (permId: number, decision: PermissionDecision) =>
      ipcRenderer.send('agent:permissionResponse', { permId, decision })
  },
  // The interactive permission gate: mode (guarded/smart persisted), a session-only
  // "trusted" override, and the saved "don't ask again" command allowlist.
  permissions: {
    get: (): Promise<PermissionState> => ipcRenderer.invoke('permissions:get'),
    setMode: (mode: PermissionMode): Promise<PermissionState> => ipcRenderer.invoke('permissions:setMode', mode),
    setTrusted: (trusted: boolean): Promise<PermissionState> => ipcRenderer.invoke('permissions:setTrusted', trusted),
    listAllowed: (): Promise<AllowedCommand[]> => ipcRenderer.invoke('permissions:listAllowed'),
    removeAllowed: (id: number): Promise<AllowedCommand[]> => ipcRenderer.invoke('permissions:removeAllowed', id),
    clearAllowed: (): Promise<AllowedCommand[]> => ipcRenderer.invoke('permissions:clearAllowed')
  },
  screen: {
    // macOS Screen Recording status: 'granted' | 'denied' | 'restricted' | 'not-determined'.
    status: (): Promise<string> => ipcRenderer.invoke('screen:status'),
    openPrivacy: (): Promise<void> => ipcRenderer.invoke('screen:openPrivacy'),
    sources: (): Promise<{ id: string; name: string; thumbnail: string }[]> =>
      ipcRenderer.invoke('screen:sources'),
    capture: (
      sourceId: string
    ): Promise<{ dataUrl: string; mediaType: string; name: string } | { error: string } | null> =>
      ipcRenderer.invoke('screen:capture', sourceId)
  },
  menu: {
    // Fires when the native File ▸ New Chat menu item is chosen.
    onNewChat: (cb: () => void) => {
      const handler = (): void => cb()
      ipcRenderer.on('menu:new-chat', handler)
      return () => ipcRenderer.removeListener('menu:new-chat', handler)
    },
    onSettings: (cb: () => void) => {
      const handler = (): void => cb()
      ipcRenderer.on('menu:settings', handler)
      return () => ipcRenderer.removeListener('menu:settings', handler)
    }
  }
}

contextBridge.exposeInMainWorld('artemis', api)
export type ArtemisAPI = typeof api
