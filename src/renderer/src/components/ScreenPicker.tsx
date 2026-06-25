import { useEffect, useState } from 'react'
import { X, Monitor, Loader2 } from 'lucide-react'

interface Source {
  id: string
  name: string
  thumbnail: string
}

/**
 * Pick a screen or window to capture. Handles the macOS Screen Recording permission
 * gate up front, then shows thumbnails; choosing one returns a full-res PNG data URL
 * via onCapture (which the composer turns into an image attachment for the vision model).
 */
export function ScreenPicker({
  onCapture,
  onClose
}: {
  onCapture: (dataUrl: string) => void
  onClose: () => void
}): JSX.Element {
  const [loading, setLoading] = useState(true)
  const [sources, setSources] = useState<Source[]>([])
  const [capturing, setCapturing] = useState(false)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      // Always call getSources — that call registers Artemis in macOS's Screen Recording
      // list and fires the permission prompt. Race a timeout and catch errors so a stalled
      // or rejected call can never leave the modal spinning forever (it falls to the help).
      try {
        const list = await Promise.race([
          window.artemis?.screen?.sources() ?? Promise.resolve([]),
          new Promise<Source[]>((_, reject) => setTimeout(() => reject(new Error('timeout')), 8000))
        ])
        if (!cancelled) setSources(list ?? [])
      } catch {
        if (!cancelled) setSources([])
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  const pick = async (id: string): Promise<void> => {
    setCapturing(true)
    try {
      const shot = await window.artemis?.screen?.capture(id)
      if (shot?.dataUrl) {
        onCapture(shot.dataUrl)
        onClose()
      }
    } finally {
      setCapturing(false)
    }
  }

  // Non-empty sources with real (non-black) thumbnails ⇒ permission is effectively
  // working. Empty ⇒ not granted yet (the getSources call above just registered the app).
  const hasSources = sources.length > 0

  return (
    <div className="projects-overlay" onClick={onClose}>
      <div className="projects-panel screen-picker" onClick={(e) => e.stopPropagation()}>
        <div className="projects-head">
          <span>
            <Monitor size={14} /> CAPTURE SCREEN
          </span>
          <button className="projects-close" onClick={onClose} title="Close">
            <X size={14} />
          </button>
        </div>

        <div className="screen-picker-body">
          {loading && (
            <div className="screen-msg">
              <Loader2 size={16} className="spin" /> Loading screens…
            </div>
          )}

          {!loading && !hasSources && (
            <div className="screen-msg">
              <p>
                No screens available yet — Artemis needs <strong>Screen Recording</strong>{' '}
                permission. It should now appear in System Settings → Privacy &amp; Security →
                Screen Recording (in development it's listed as <strong>“Electron”</strong>, not
                “Artemis”). Enable it, then <strong>restart Artemis</strong> and try again.
              </p>
              <button className="projects-add" onClick={() => window.artemis?.screen?.openPrivacy()}>
                Open System Settings
              </button>
            </div>
          )}

          {!loading && hasSources && (
            <div className={`screen-grid ${capturing ? 'busy' : ''}`}>
              {sources.map((s) => (
                <button key={s.id} className="screen-source" onClick={() => pick(s.id)} title={s.name}>
                  <img src={s.thumbnail} alt={s.name} />
                  <span className="screen-source-name">{s.name}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
