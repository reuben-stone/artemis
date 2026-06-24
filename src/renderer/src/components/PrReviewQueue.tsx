import { X, ExternalLink, GitPullRequest, Trash2 } from 'lucide-react'
import type { PrReview } from '../../../preload'

/**
 * PR Review Queue — a dismissable docked card (bottom-left of the orb window). Each PR
 * a worker agent opens lands here (newest unreviewed first); check them off in the
 * morning. SQLite-backed, so the queue survives restarts.
 */
export function PrReviewQueue({
  prs,
  onToggle,
  onClearReviewed,
  onClose
}: {
  prs: PrReview[]
  onToggle: (id: number, reviewed: boolean) => void
  onClearReviewed: () => void
  onClose: () => void
}): JSX.Element {
  const pending = prs.filter((p) => !p.reviewed).length
  const hasReviewed = prs.some((p) => p.reviewed)

  return (
    <div className="dock-card">
      <div className="dock-card-head">
        <span className="dock-card-title">
          <GitPullRequest size={14} /> PR Review{pending > 0 ? ` · ${pending}` : ''}
        </span>
        <div className="dock-card-actions">
          {hasReviewed && (
            <button onClick={onClearReviewed} title="Remove checked-off PRs">
              <Trash2 size={14} />
            </button>
          )}
          <button onClick={onClose} title="Dismiss">
            <X size={14} />
          </button>
        </div>
      </div>

      <div className="dock-card-body">
        {prs.length === 0 && (
          <div className="dock-loading">No PRs awaiting review — worker agents log theirs here.</div>
        )}
        {prs.map((p) => (
          <div key={p.id} className={`pr-row ${p.reviewed ? 'done' : ''}`}>
            <input
              type="checkbox"
              className="pr-check"
              checked={p.reviewed}
              onChange={(e) => onToggle(p.id, e.target.checked)}
              title={p.reviewed ? 'Mark as not reviewed' : 'Mark reviewed'}
            />
            <div className="pr-body">
              <a className="pr-title" href={p.url} target="_blank" rel="noreferrer" title="Open on GitHub">
                {p.title} <ExternalLink size={12} />
              </a>
              <div className="pr-meta">
                <span className="pr-project">{p.project}</span>
                {p.branch && <span className="pr-branch">{p.branch}</span>}
                {p.agent && <span className="pr-agent">{p.agent}</span>}
                <span className="pr-time">{relativeTime(p.created_at)}</span>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

function relativeTime(ts: number): string {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000))
  if (s < 60) return 'just now'
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.round(m / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.round(h / 24)}d ago`
}
