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
  const [status, setStatus] = useState<string | null>(null)
  const [sources, setSources] = useState<Source[] | null>(null)
  const [capturing, setCapturing] = useState(false)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      const s = (await window.artemis?.screen?.status()) ?? 'granted'
      if (cancelled) return
      setStatus(s)
      if (s === 'granted') {
        const list = (await window.artemis?.screen?.sources()) ?? []
        if (!cancelled) setSources(list)
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

  const granted = status === 'granted'

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
          {status === null && (
            <div className="screen-msg">
              <Loader2 size={16} className="spin" /> Checking permission…
            </div>
          )}

          {status !== null && !granted && (
            <div className="screen-msg">
              <p>
                Artemis needs <strong>Screen Recording</strong> permission to see your screen.
                Enable it for Artemis in System Settings → Privacy &amp; Security → Screen
                Recording, then <strong>restart Artemis</strong>.
              </p>
              <button className="projects-add" onClick={() => window.artemis?.screen?.openPrivacy()}>
                Open System Settings
              </button>
            </div>
          )}

          {granted && sources === null && (
            <div className="screen-msg">
              <Loader2 size={16} className="spin" /> Loading windows…
            </div>
          )}

          {granted && sources !== null && sources.length === 0 && (
            <div className="screen-msg">No capturable screens or windows found.</div>
          )}

          {granted && sources && sources.length > 0 && (
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
