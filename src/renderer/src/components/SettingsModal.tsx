import { useEffect, useState } from 'react'
import { X, CircleCheck, Circle } from 'lucide-react'
import type { Project, ConnectionsStatus } from '../../../preload'

type Tab = 'model' | 'voice' | 'connections' | 'general'

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
  // Connections
  projects: Project[]
  onSetGaProperty: (path: string, propertyId: string) => void
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
      </div>

      <div className="set-field" style={{ marginTop: 16 }}>
        <span className="set-label">Brain</span>
        <div className="seg">
          <button className={p.backend !== 'ollama' ? 'on' : ''} onClick={() => p.backend === 'ollama' && p.onToggleBackend()}>
            ☁ Cloud
          </button>
          <button className={p.backend === 'ollama' ? 'on' : ''} onClick={() => p.backend !== 'ollama' && p.onToggleBackend()}>
            ⌂ Local
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
    </section>
  )
}

function ConnectionsTab(p: {
  projects: Project[]
  onSetGaProperty: (path: string, propertyId: string) => void
}): JSX.Element {
  const [status, setStatus] = useState<ConnectionsStatus | null>(null)
  const [keyDraft, setKeyDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const refresh = (): void => {
    window.artemis?.connections?.status().then((s) => s && setStatus(s))
  }
  useEffect(refresh, [])
  const dot = (ok: boolean): JSX.Element =>
    ok ? (
      <CircleCheck size={14} className="conn-dot ok" />
    ) : (
      <Circle size={14} className="conn-dot off" />
    )

  return (
    <div className="conn-body" style={{ padding: 0 }}>
      <section className="conn-section">
        <div className="conn-title">{dot(!!status?.anthropic)} Anthropic API key</div>
        <div className="conn-detail">
          {status?.anthropic ? 'Key is set.' : 'No key — paste one to enable the cloud model.'}
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
          {status?.github.connected
            ? `Connected as ${status.github.user}. Worker agents open PRs through this.`
            : 'Not connected. Run gh auth login in the terminal (type "! gh auth login").'}
        </div>
      </section>

      <section className="conn-section">
        <div className="conn-title">{dot(!!status?.ga.configured)} Google Analytics</div>
        <div className="conn-detail">
          {status?.ga.configured
            ? 'Service account configured. Set a GA4 property id per project for the morning review.'
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
              <div className="conn-ga-row" key={proj.id}>
                <span className="conn-ga-name">{proj.name}</span>
                <input
                  className="ollama-field"
                  style={{ width: 150 }}
                  placeholder="GA4 property id"
                  defaultValue={proj.gaProperty ?? ''}
                  onBlur={(e) => p.onSetGaProperty(proj.path, e.target.value.trim())}
                  spellCheck={false}
                />
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  )
}
