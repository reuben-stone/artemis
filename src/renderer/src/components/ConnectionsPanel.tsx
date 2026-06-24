import { useEffect, useState } from 'react'
import type { Project, ConnectionsStatus } from '../../../preload'

/**
 * Connections / onboarding panel — one place to see and set up every integration, so
 * moving Artemis to a new machine is point-and-click: Anthropic key, GitHub (gh), and
 * Google Analytics (service-account JSON + per-project property ids feeding the morning
 * review).
 */
export function ConnectionsPanel({
  projects,
  onSetGaProperty,
  onClose
}: {
  projects: Project[]
  onSetGaProperty: (path: string, propertyId: string) => void
  onClose: () => void
}): JSX.Element {
  const [status, setStatus] = useState<ConnectionsStatus | null>(null)
  const [keyDraft, setKeyDraft] = useState('')
  const [busy, setBusy] = useState(false)

  const refresh = (): void => {
    window.artemis?.connections?.status().then((s) => s && setStatus(s))
  }
  useEffect(refresh, [])

  const dot = (ok: boolean): JSX.Element => (
    <span className={`conn-dot ${ok ? 'ok' : 'off'}`}>{ok ? '●' : '○'}</span>
  )

  return (
    <div className="projects-overlay" onClick={onClose}>
      <div className="projects-panel connections" onClick={(e) => e.stopPropagation()}>
        <div className="projects-head">
          <span>CONNECTIONS</span>
          <button className="projects-close" onClick={onClose} title="Close">
            ✕
          </button>
        </div>

        <div className="projects-list conn-body">
          {/* Anthropic */}
          <section className="conn-section">
            <div className="conn-title">
              {dot(!!status?.anthropic)} Anthropic API key
            </div>
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

          {/* GitHub */}
          <section className="conn-section">
            <div className="conn-title">
              {dot(!!status?.github.connected)} GitHub
            </div>
            <div className="conn-detail">
              {status?.github.connected
                ? `Connected as ${status.github.user}. Worker agents open PRs through this.`
                : 'Not connected. Run gh auth login in the terminal (type "! gh auth login").'}
            </div>
          </section>

          {/* Google Analytics */}
          <section className="conn-section">
            <div className="conn-title">
              {dot(!!status?.ga.configured)} Google Analytics
            </div>
            <div className="conn-detail">
              {status?.ga.configured
                ? 'Service account configured. Set a GA4 property id per project below to include analytics in the morning review.'
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
                {projects.map((p) => (
                  <div className="conn-ga-row" key={p.id}>
                    <span className="conn-ga-name">{p.name}</span>
                    <input
                      className="ollama-field"
                      style={{ width: 150 }}
                      placeholder="GA4 property id"
                      defaultValue={p.gaProperty ?? ''}
                      onBlur={(e) => onSetGaProperty(p.path, e.target.value.trim())}
                      spellCheck={false}
                    />
                  </div>
                ))}
              </div>
            )}
          </section>
        </div>
      </div>
    </div>
  )
}
