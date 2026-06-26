import { useCallback, useEffect, useRef, useState } from 'react'
import { X, CircleCheck, Circle, Plus, Loader2, Cloud, HardDrive, RefreshCw } from 'lucide-react'
import type { Project, ConnectionsStatus, GaProp, BoardConfig } from '../../../preload'
import { ACCENTS, applyAccent, currentAccentId } from '../theme'

type Tab = 'model' | 'voice' | 'connections' | 'general'

/* Brand marks for the provider chips (inline SVG — lucide dropped brand icons). currentColor
   for GitHub so it tints with the chip; Jira/Azure carry their own brand blue. */
function GitHubMark(): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" width="17" height="17" fill="currentColor" aria-hidden="true">
      <path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12" />
    </svg>
  )
}
function JiraMark(): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" width="17" height="17" fill="#2684FF" aria-hidden="true">
      <path d="M11.571 11.513H0a5.218 5.218 0 0 0 5.232 5.215h2.13v2.057A5.215 5.215 0 0 0 12.575 24V12.518a1.005 1.005 0 0 0-1.005-1.005zm5.723-5.756H5.736a5.215 5.215 0 0 0 5.215 5.214h2.129v2.058a5.218 5.218 0 0 0 5.215 5.214V6.758a1.001 1.001 0 0 0-1-1.001zM23.013 0H11.455a5.215 5.215 0 0 0 5.215 5.215h2.129v2.057A5.215 5.215 0 0 0 24 12.483V1.005A1.001 1.001 0 0 0 23.013 0z" />
    </svg>
  )
}
function AzureMark(): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" width="17" height="17" fill="#0078D7" aria-hidden="true">
      <path d="M0 8.877L2.247 5.91l8.405-3.416V.022l7.37 5.393L2.966 8.338v8.225L0 15.707zm24-4.45v14.651l-5.753 4.9-9.303-3.057v3.056l-5.978-7.416 15.057 1.798V5.415z" />
    </svg>
  )
}

// Ticket providers for the board connector. GitHub is wired; Jira/Azure are the planned seam
// (BoardConfig.provider) — shown disabled so the multi-provider intent is visible without
// over-promising. When one lands, flip `live` and point it at its own configurator.
const PROVIDERS: Array<{ id: 'github' | 'jira' | 'azure'; label: string; sub: string; live: boolean; icon: JSX.Element }> = [
  { id: 'github', label: 'GitHub Projects', sub: 'Connected', live: true, icon: <GitHubMark /> },
  { id: 'jira', label: 'Jira', sub: 'Planned', live: false, icon: <JiraMark /> },
  { id: 'azure', label: 'Azure DevOps', sub: 'Planned', live: false, icon: <AzureMark /> }
]

/**
 * One Settings modal — the home for everything configurable, so the toolbar stays
 * lean (context + actions + status). New config drops in as a row/tab here instead of
 * another toolbar button. Tabs: Model & Backend, Voice, Connections, General.
 */
export function SettingsModal(props: {
  // Model & Backend
  model: string
  onToggleModel: () => void
  backend: string
  onToggleBackend: () => void
  ollamaHost: string
  ollamaModel: string
  onSetOllama: (patch: { ollamaHost?: string; ollamaModel?: string }) => void
  // Voice
  voices: string[]
  selectedVoice: string
  onSetVoice: (v: string) => void
  onPreviewVoice: (v: string) => void
  // General
  autoLaunch: boolean
  onToggleAutoLaunch: () => void
  showTerminal: boolean
  onToggleTerminal: () => void
  showCost: boolean
  onToggleShowCost: () => void
  // Connections
  projects: Project[]
  onSetGaProps: (path: string, props: GaProp[]) => void
  onSetBoards: (path: string, boards: BoardConfig[]) => void
  onAddProject: () => void | Promise<void>
  onClose: () => void
}): JSX.Element {
  const [tab, setTab] = useState<Tab>('model')

  return (
    <div className="projects-overlay" onClick={props.onClose}>
      <div className="projects-panel settings-modal" onClick={(e) => e.stopPropagation()}>
        <div className="projects-head">
          <span>SETTINGS</span>
          <button className="projects-close" onClick={props.onClose} title="Close">
            <X size={14} />
          </button>
        </div>

        <div className="settings-tabs">
          {(
            [
              ['model', 'Model & Backend'],
              ['voice', 'Voice'],
              ['connections', 'Connections'],
              ['general', 'General']
            ] as [Tab, string][]
          ).map(([id, label]) => (
            <button
              key={id}
              className={`settings-tab ${tab === id ? 'active' : ''}`}
              onClick={() => setTab(id)}
            >
              {label}
            </button>
          ))}
        </div>

        <div className="settings-body">
          {tab === 'model' && <ModelTab {...props} />}
          {tab === 'voice' && <VoiceTab {...props} />}
          {tab === 'connections' && <ConnectionsTab {...props} />}
          {tab === 'general' && <GeneralTab {...props} />}
        </div>
      </div>
    </div>
  )
}

function ModelTab(p: {
  model: string
  onToggleModel: () => void
  backend: string
  onToggleBackend: () => void
  ollamaHost: string
  ollamaModel: string
  onSetOllama: (patch: { ollamaHost?: string; ollamaModel?: string }) => void
}): JSX.Element {
  const [host, setHost] = useState(p.ollamaHost)
  const [model, setModel] = useState(p.ollamaModel)
  return (
    <section className="conn-section" style={{ borderBottom: 'none' }}>
      <div className="set-field">
        <span className="set-label">Model</span>
        <div className="seg">
          <button className={p.model !== 'claude-opus-4-8' ? 'on' : ''} onClick={() => p.model === 'claude-opus-4-8' && p.onToggleModel()}>
            Sonnet
          </button>
          <button className={p.model === 'claude-opus-4-8' ? 'on' : ''} onClick={() => p.model !== 'claude-opus-4-8' && p.onToggleModel()}>
            Opus
          </button>
        </div>
      </div>
      <div className="conn-detail" style={{ marginLeft: 0 }}>
        Sonnet is fast &amp; cheap (default); Opus is max capability. Cloud only.
        <br />
        Takes effect on your next message — no restart needed.
      </div>

      <div className="set-field" style={{ marginTop: 16 }}>
        <span className="set-label">Brain</span>
        <div className="seg">
          <button className={p.backend !== 'ollama' ? 'on' : ''} onClick={() => p.backend === 'ollama' && p.onToggleBackend()}>
            <Cloud size={13} /> Cloud
          </button>
          <button className={p.backend === 'ollama' ? 'on' : ''} onClick={() => p.backend !== 'ollama' && p.onToggleBackend()}>
            <HardDrive size={13} /> Local
          </button>
        </div>
      </div>
      {p.backend === 'ollama' && (
        <div className="conn-ga-props" style={{ marginLeft: 0, marginTop: 10 }}>
          <div className="conn-ga-row">
            <span className="conn-ga-name">Ollama host</span>
            <input
              className="ollama-field"
              style={{ width: 220 }}
              value={host}
              onChange={(e) => setHost(e.target.value)}
              onBlur={() => p.onSetOllama({ ollamaHost: host })}
              placeholder="http://localhost:11434"
              spellCheck={false}
            />
          </div>
          <div className="conn-ga-row">
            <span className="conn-ga-name">Ollama model</span>
            <input
              className="ollama-field"
              style={{ width: 220 }}
              value={model}
              onChange={(e) => setModel(e.target.value)}
              onBlur={() => p.onSetOllama({ ollamaModel: model })}
              placeholder="qwen2.5-coder:7b"
              spellCheck={false}
            />
          </div>
          <div className="conn-detail" style={{ marginLeft: 0 }}>
            Point at localhost or a brain box on your network (http://&lt;ip&gt;:11434).
          </div>
        </div>
      )}
    </section>
  )
}

function VoiceTab(p: {
  voices: string[]
  selectedVoice: string
  onSetVoice: (v: string) => void
  onPreviewVoice: (v: string) => void
}): JSX.Element {
  return (
    <section className="conn-section" style={{ borderBottom: 'none' }}>
      <div className="set-field">
        <span className="set-label">Voice</span>
        <select
          className="voice-select"
          style={{ maxWidth: 240 }}
          value={p.selectedVoice}
          onChange={(e) => {
            p.onSetVoice(e.target.value)
            p.onPreviewVoice(e.target.value)
          }}
        >
          {p.voices.map((v) => (
            <option key={v} value={v}>
              {v}
            </option>
          ))}
        </select>
      </div>
      <div className="conn-detail" style={{ marginLeft: 0 }}>
        The voice Artemis speaks in. Toggle voice on/off from the speaker icon by the chat
        input. (Streaming neural TTS is a later upgrade.)
      </div>
    </section>
  )
}

function GeneralTab(p: {
  autoLaunch: boolean
  onToggleAutoLaunch: () => void
  showTerminal: boolean
  onToggleTerminal: () => void
  showCost: boolean
  onToggleShowCost: () => void
}): JSX.Element {
  return (
    <section className="conn-section" style={{ borderBottom: 'none' }}>
      <label className="set-toggle">
        <input type="checkbox" checked={p.autoLaunch} onChange={p.onToggleAutoLaunch} />
        Launch Artemis at login
      </label>
      <label className="set-toggle">
        <input type="checkbox" checked={p.showTerminal} onChange={p.onToggleTerminal} />
        Show terminal pane
      </label>
      <label className="set-toggle">
        <input type="checkbox" checked={p.showCost} onChange={p.onToggleShowCost} />
        Show cost estimate in top bar
      </label>
      <div className="conn-detail" style={{ marginLeft: 0 }}>
        A rough running total at Anthropic list prices. Off by default; reads $0 on the
        local model.
      </div>

      <div className="set-field" style={{ marginTop: 18 }}>
        <span className="set-label">Accent</span>
        <AccentPicker />
      </div>
      <div className="conn-detail" style={{ marginLeft: 0 }}>
        The highlight colour across the interface. Applies instantly.
      </div>
    </section>
  )
}

function AccentPicker(): JSX.Element {
  const [sel, setSel] = useState(currentAccentId())
  return (
    <div className="accent-swatches">
      {ACCENTS.map((a) => (
        <button
          key={a.id}
          className={`accent-swatch ${sel === a.id ? 'on' : ''}`}
          style={{ background: a.hex }}
          title={a.name}
          onClick={() => {
            applyAccent(a)
            setSel(a.id)
          }}
        />
      ))}
    </div>
  )
}

/** One project's GA4 properties — a labelled list (a monorepo can have several). */
function GaProjectEditor({
  project,
  onSet
}: {
  project: Project
  onSet: (path: string, props: GaProp[]) => void
}): JSX.Element {
  const [rows, setRows] = useState<GaProp[]>(project.gaProps ?? [])
  const commit = (next: GaProp[]): void => {
    setRows(next)
    onSet(project.path, next)
  }
  return (
    <div className="conn-ga-project">
      <div className="conn-ga-name">{project.name}</div>
      {rows.map((row, i) => (
        <div className="conn-ga-row" key={i}>
          <input
            className="ollama-field"
            style={{ width: 110 }}
            placeholder="label (e.g. Lumi)"
            value={row.label}
            onChange={(e) => commit(rows.map((r, j) => (j === i ? { ...r, label: e.target.value } : r)))}
            spellCheck={false}
          />
          <input
            className="ollama-field"
            style={{ width: 150 }}
            placeholder="GA4 property id"
            value={row.id}
            onChange={(e) => commit(rows.map((r, j) => (j === i ? { ...r, id: e.target.value } : r)))}
            spellCheck={false}
          />
          <button
            className="conn-clear"
            style={{ padding: '4px 8px' }}
            onClick={() => commit(rows.filter((_, j) => j !== i))}
            title="Remove"
          >
            <X size={13} />
          </button>
        </div>
      ))}
      <button
        className="conn-ga-add"
        onClick={() => commit([...rows, { label: '', id: '' }])}
      >
        <Plus size={12} /> add property
      </button>
    </div>
  )
}

/** One project's GitHub Projects (v2) board mappings — a LIST, since a monorepo holds several
 *  (Lumi, LumiLens…). Each board optionally carries a subdir to focus worker dispatch. Owner is
 *  pre-filled from the repo's remote; boards are picked from a dropdown of the owner's actual
 *  boards (the query also reports org-vs-user). */
function BoardProjectEditor({
  project,
  onSet
}: {
  project: Project
  onSet: (path: string, boards: BoardConfig[]) => void | Promise<void>
}): JSX.Element {
  const detectedOwner = project.gh?.slug.split('/')[0] ?? ''
  const [boards, setBoards] = useState<BoardConfig[]>(project.boards ?? [])
  const boardsRef = useRef(boards)
  boardsRef.current = boards
  const [owner, setOwner] = useState(detectedOwner)
  const [ownerType, setOwnerType] = useState<'org' | 'user'>('org')
  const [available, setAvailable] = useState<Array<{ number: number; title: string; closed: boolean }>>([])
  const [pick, setPick] = useState('')
  const [loading, setLoading] = useState(false)
  const [listError, setListError] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)
  const [testing, setTesting] = useState(false)
  const [result, setResult] = useState<string | null>(null)

  const commit = (next: BoardConfig[]): void => {
    setBoards(next)
    void onSet(project.path, next)
  }

  const loadAvailable = useCallback(async (o: string): Promise<void> => {
    if (!o.trim()) return
    setLoading(true)
    setListError(null)
    try {
      const res = await window.artemis?.board?.listBoards(o.trim())
      if (res?.ok) {
        setAvailable(res.boards.filter((b) => !b.closed))
        setOwnerType(res.ownerType)
      } else {
        setAvailable([])
        setListError(res?.error ?? 'Could not list boards.')
      }
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (detectedOwner) void loadAvailable(detectedOwner)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const addBoard = (): void => {
    const n = Number(pick)
    if (!n || !owner.trim() || boards.some((b) => b.number === n && b.owner === owner.trim())) return
    const title = available.find((b) => b.number === n)?.title
    commit([...boards, { provider: 'github', owner: owner.trim(), ownerType, number: n, title, subdir: '' }])
    setPick('')
    setAdding(false)
  }
  const removeBoard = (i: number): void => commit(boards.filter((_, j) => j !== i))
  const setSubdir = (i: number, subdir: string): void => setBoards(boards.map((b, j) => (j === i ? { ...b, subdir } : b)))

  const test = async (): Promise<void> => {
    setTesting(true)
    setResult(null)
    try {
      const res = await window.artemis?.tickets?.sync(project.name)
      if (res) setResult(res.errors?.length ? `⚠ ${res.errors.join('; ')}` : `✓ ${res.tickets.length} ticket(s) synced`)
    } finally {
      setTesting(false)
    }
  }

  return (
    <div className="conn-ga-project">
      <div className="conn-ga-name">
        {project.name}
        {boards.length > 0 && (
          <button className="projects-add" style={{ padding: '3px 9px', marginLeft: 8 }} disabled={testing} onClick={() => void test()}>
            {testing ? '…' : 'Test sync'}
          </button>
        )}
      </div>

      {boards.map((b, i) => (
        <div className="conn-ga-row" key={`${b.owner}#${b.number}`}>
          <span className="conn-board-name">{b.title || `#${b.number}`}</span>
          <input
            className="ollama-field"
            style={{ width: 190 }}
            placeholder="subdir (optional, e.g. apps/scanner)"
            value={b.subdir ?? ''}
            onChange={(e) => setSubdir(i, e.target.value)}
            onBlur={() => void onSet(project.path, boardsRef.current)}
            title="A monorepo workspace this board focuses worker dispatch on (full repo access kept)"
            spellCheck={false}
          />
          <button className="conn-clear" style={{ padding: '4px 8px' }} onClick={() => removeBoard(i)} title="Remove board">
            <X size={13} />
          </button>
        </div>
      ))}

      {adding ? (
        <div className="conn-ga-row">
          <input
            className="ollama-field"
            style={{ width: 140 }}
            placeholder="owner login"
            value={owner}
            onChange={(e) => setOwner(e.target.value)}
            onBlur={() => void loadAvailable(owner)}
            spellCheck={false}
          />
          <button className="hud-mini" onClick={() => void loadAvailable(owner)} title="Load boards" disabled={loading || !owner.trim()}>
            <RefreshCw size={12} className={loading ? 'spin' : ''} />
          </button>
          {available.length > 0 ? (
            <select className="voice-select" style={{ maxWidth: 200 }} value={pick} onChange={(e) => setPick(e.target.value)}>
              <option value="">Select a board…</option>
              {available
                .filter((b) => !boards.some((x) => x.number === b.number && x.owner === owner.trim()))
                .map((b) => (
                  <option key={b.number} value={b.number}>
                    {b.title} (#{b.number})
                  </option>
                ))}
            </select>
          ) : (
            <input
              className="ollama-field"
              style={{ width: 56 }}
              placeholder="#"
              value={pick}
              onChange={(e) => setPick(e.target.value.replace(/[^0-9]/g, ''))}
              spellCheck={false}
            />
          )}
          <button className="projects-add" style={{ padding: '4px 9px' }} disabled={!Number(pick) || !owner.trim()} onClick={addBoard}>
            Add
          </button>
          <button className="conn-clear" style={{ padding: '4px 8px' }} onClick={() => setAdding(false)}>
            <X size={13} />
          </button>
        </div>
      ) : (
        <button
          className="conn-ga-add"
          onClick={() => {
            setAdding(true)
            if (!available.length) void loadAvailable(owner)
          }}
        >
          <Plus size={12} /> add board
        </button>
      )}

      {listError && (
        <div className="conn-detail" style={{ marginLeft: 0, fontSize: 11, color: '#ff8a8a' }}>
          ⚠ {listError} — or enter the board # manually. Projects v2 needs the gh <code>project</code> scope.
        </div>
      )}
      {result && <div className="conn-detail" style={{ marginLeft: 0 }}>{result}</div>}
    </div>
  )
}

function ConnectionsTab(p: {
  projects: Project[]
  onSetGaProps: (path: string, props: GaProp[]) => void
  onSetBoards: (path: string, boards: BoardConfig[]) => void
  onAddProject: () => void | Promise<void>
}): JSX.Element {
  const [status, setStatus] = useState<ConnectionsStatus | null>(null)
  const [keyDraft, setKeyDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [projectScope, setProjectScope] = useState<boolean | null>(null) // gh Projects v2 scope present?
  // Which ticket provider's configurator is shown. Only GitHub is wired; Jira/Azure are the
  // forward-compat seam (see BoardConfig.provider) — selectable later, shown as Planned for now.
  const [provider, setProvider] = useState<'github' | 'jira' | 'azure'>('github')
  const refresh = (): void => {
    window.artemis?.connections?.status().then((s) => s && setStatus(s))
  }
  useEffect(refresh, [])
  // Probe the gh Projects v2 scope once GitHub is connected (drives the board onboarding hint).
  useEffect(() => {
    if (status?.github.connected) window.artemis?.connections?.checkProjectScope().then(setProjectScope)
  }, [status?.github.connected])
  const loading = status === null
  const dot = (ok: boolean): JSX.Element =>
    loading ? (
      <Loader2 size={14} className="conn-dot spin" />
    ) : ok ? (
      <CircleCheck size={14} className="conn-dot ok" />
    ) : (
      <Circle size={14} className="conn-dot off" />
    )

  return (
    <div className="conn-body" style={{ padding: 0 }}>
      <section className="conn-section">
        <div className="conn-title">{dot(!!status?.anthropic)} Anthropic API key</div>
        <div className="conn-detail">
          {loading
            ? 'Checking…'
            : status?.anthropic
              ? 'Key is set.'
              : 'No key — paste one to enable the cloud model.'}
        </div>
        <div className="conn-row">
          <input
            className="ollama-field"
            style={{ width: 240 }}
            type="password"
            placeholder="sk-ant-…"
            value={keyDraft}
            onChange={(e) => setKeyDraft(e.target.value)}
            spellCheck={false}
          />
          <button
            className="projects-add"
            disabled={!keyDraft.trim() || busy}
            onClick={async () => {
              setBusy(true)
              try {
                await window.artemis?.auth?.setKey(keyDraft.trim())
                setKeyDraft('')
                refresh()
              } finally {
                setBusy(false)
              }
            }}
          >
            Save
          </button>
          {status?.anthropic && (
            <button
              className="conn-clear"
              onClick={async () => {
                await window.artemis?.auth?.clearKey()
                refresh()
              }}
            >
              Clear
            </button>
          )}
        </div>
      </section>

      <section className="conn-section">
        <div className="conn-title">{dot(!!status?.github.connected)} GitHub</div>
        <div className="conn-detail">
          {loading
            ? 'Checking…'
            : status?.github.connected
              ? `Connected as ${status.github.user}. Worker agents open PRs through this.`
              : 'Not connected. Run gh auth login in the terminal (type "! gh auth login").'}
        </div>
        {status?.github.connected && (
          <>
            {/* Ticket provider selector — GitHub is live; Jira/Azure are the planned seam. */}
            <div className="prov-picker" role="radiogroup" aria-label="Ticket provider">
              {PROVIDERS.map((pv) => (
                <button
                  key={pv.id}
                  className={`prov-chip ${provider === pv.id ? 'on' : ''}`}
                  role="radio"
                  aria-checked={provider === pv.id}
                  disabled={!pv.live}
                  onClick={() => pv.live && setProvider(pv.id)}
                  title={pv.live ? `Configure ${pv.label}` : `${pv.label} — planned, not available yet`}
                >
                  <span className="prov-chip-logo">{pv.icon}</span>
                  <span className="prov-chip-text">
                    <span className="prov-chip-label">{pv.label}</span>
                    <span className="prov-chip-sub">{pv.live ? pv.sub : 'Planned'}</span>
                  </span>
                </button>
              ))}
            </div>

            <div className="conn-note">
              <strong>Projects board</strong> — map a project to its GitHub Projects (v2) board(s) so
              Artemis can read tickets and dispatch from them. A <strong>monorepo</strong> can have
              several (add Lumi <em>and</em> LumiLens to <code>livana-scanner</code>); give each a{' '}
              <strong>subdir</strong> (e.g. <code>apps/scanner</code>) and a worker dispatched from
              that board focuses there while keeping full-repo access for shared code.
              Projects v2 needs an extra scope: run{' '}
              <code>gh auth refresh -s read:project,project</code> once (type{' '}
              <code>! gh auth refresh -s read:project,project</code>).
            </div>
            {projectScope === false && (
              <div className="conn-detail" style={{ marginLeft: 0, color: '#ff8a8a' }}>
                ⚠ Your gh token is missing the Projects v2 scope — boards won't list or sync until you run the refresh above.
              </div>
            )}
            {projectScope === true && (
              <div className="conn-detail" style={{ marginLeft: 0, color: '#27e0a8' }}>✓ Projects v2 scope granted.</div>
            )}
            <div className="conn-ga-props">
              {p.projects
                .filter((proj) => proj.gh)
                .map((proj) => (
                  <BoardProjectEditor key={proj.id} project={proj} onSet={p.onSetBoards} />
                ))}
              {/* Add a whole repo to the registry; map its board(s) inline above. */}
              <button className="conn-ga-add" onClick={() => void p.onAddProject()} title="Register another repo folder">
                <Plus size={12} /> Add a repo
              </button>
            </div>
          </>
        )}
      </section>

      <section className="conn-section">
        <div className="conn-title">{dot(!!status?.ga.configured)} Google Analytics</div>
        <div className="conn-detail">
          {loading
            ? 'Checking…'
            : status?.ga.configured
              ? 'Service account configured. Add GA4 property ids per project (a monorepo can have several) for the morning review.'
              : 'Add a GA4 service-account JSON key (granted Viewer on your properties).'}
        </div>
        <div className="conn-row">
          <button
            className="projects-add"
            disabled={busy}
            onClick={async () => {
              setBusy(true)
              try {
                const r = await window.artemis?.connections?.setGaCredentials()
                if (r && !r.ok && r.error) alert(`GA credentials: ${r.error}`)
                refresh()
              } finally {
                setBusy(false)
              }
            }}
          >
            {status?.ga.configured ? 'Replace JSON key…' : 'Choose service-account JSON…'}
          </button>
          {status?.ga.configured && (
            <button
              className="conn-clear"
              onClick={async () => {
                await window.artemis?.connections?.clearGaCredentials()
                refresh()
              }}
            >
              Clear
            </button>
          )}
        </div>
        {status?.ga.configured && (
          <div className="conn-ga-props">
            {p.projects.map((proj) => (
              <GaProjectEditor key={proj.id} project={proj} onSet={p.onSetGaProps} />
            ))}
          </div>
        )}
      </section>
    </div>
  )
}
