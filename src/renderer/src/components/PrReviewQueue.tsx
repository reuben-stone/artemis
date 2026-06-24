import type { PrReview } from '../../../preload'

/**
 * PR Review Queue — the human-approval surface for worker-agent autonomy. Each PR an
 * agent opens lands here (newest unreviewed first); Reuben clicks through and checks
 * each off in the morning. Persisted in SQLite, so the queue survives restarts.
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
    <div className="projects-overlay" onClick={onClose}>
      <div className="projects-panel" onClick={(e) => e.stopPropagation()}>
        <div className="projects-head">
          <span>PR REVIEW QUEUE{pending > 0 ? ` · ${pending} to review` : ''}</span>
          <div className="projects-head-actions">
            {hasReviewed && (
              <button className="projects-add" onClick={onClearReviewed} title="Remove checked-off PRs">
                Clear done
              </button>
            )}
            <button className="projects-close" onClick={onClose} title="Close">
              ✕
            </button>
          </div>
        </div>

        <div className="projects-list">
          {prs.length === 0 && (
            <div className="projects-empty">
              No PRs awaiting review. Worker agents will log their PRs here.
            </div>
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
                <a
                  className="pr-title"
                  href={p.url}
                  target="_blank"
                  rel="noreferrer"
                  title="Open the PR on GitHub"
                >
                  {p.title} ↗
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
