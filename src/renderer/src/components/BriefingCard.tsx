import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkBreaks from 'remark-breaks'
import { X, RefreshCw, Loader2, Sunrise } from 'lucide-react'

/**
 * A dismissable docked card (lives in the orb-window dock) showing the latest
 * on-command briefing — a cross-repo ecosystem + analytics review. First of a set
 * of ambient cards that surface here.
 */
export function BriefingCard({
  text,
  at,
  loading,
  onRefresh,
  onClose
}: {
  text: string
  at: number | null
  loading: boolean
  onRefresh: () => void
  onClose: () => void
}): JSX.Element {
  return (
    <div className="dock-card">
      <div className="dock-card-head">
        <span className="dock-card-title">
          <Sunrise size={14} /> Briefing{at ? ` · ${timeAgo(at)}` : ''}
        </span>
        <div className="dock-card-actions">
          <button onClick={onRefresh} title="Regenerate" disabled={loading}>
            {loading ? <Loader2 size={14} className="spin" /> : <RefreshCw size={14} />}
          </button>
          <button onClick={onClose} title="Dismiss">
            <X size={14} />
          </button>
        </div>
      </div>
      <div className="dock-card-body">
        {loading && !text ? (
          <div className="dock-loading">
            <Loader2 size={16} className="spin" /> Generating your briefing…
          </div>
        ) : (
          <div className="md">
            <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]}>
              {text || 'No briefing yet — hit regenerate.'}
            </ReactMarkdown>
          </div>
        )}
      </div>
    </div>
  )
}

function timeAgo(ts: number): string {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000))
  if (s < 60) return 'just now'
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.round(m / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.round(h / 24)}d ago`
}
