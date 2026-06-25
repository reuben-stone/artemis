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
  const [error, setError] = useState<string | null>(null)

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
    setError(null)
    try {
      const shot = await window.artemis?.screen?.capture(id)
      if (shot && 'dataUrl' in shot && shot.dataUrl) {
        onCapture(shot.dataUrl)
        onClose()
      } else {
        // A failed capture used to return null and silently leave the modal sitting
        // there — now we surface why instead of "nothing happens".
        setError((shot && 'error' in shot && shot.error) || 'Capture failed — try again.')
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Capture failed — try again.')
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
                No screens available yet — <strong>Screen Recording</strong> permission is
                needed. In System Settings → Privacy &amp; Security → Screen Recording, enable
                the entry for this app and relaunch. In development the grant is usually
                attributed to your <strong>terminal app</strong> (e.g. Terminal or iTerm), not
                “Artemis” — toggle <em>that</em> one and relaunch. For a clean “Artemis” entry,
                run the packaged <strong>Artemis.app</strong> from /Applications.
              </p>
              <button className="projects-add" onClick={() => window.artemis?.screen?.openPrivacy()}>
                Open System Settings
              </button>
            </div>
          )}

          {error && <div className="screen-msg screen-err">{error}</div>}

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
