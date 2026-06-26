import { useState } from 'react'
import { X, RefreshCw, Loader2, Sunrise, ChevronDown, ChevronRight, ExternalLink, GitCommitHorizontal, GitBranch, History } from 'lucide-react'
import type { BriefingData } from '../../../preload'

/**
 * Dismissable docked briefing card — a clean, scannable cross-repo summary. Per
 * project: a one-line header + prominent analytics, with PRs/uncommitted tucked into
 * an accordion. Structured (not LLM markdown) so it stays tidy.
 */
export function BriefingCard({
  data,
  loading,
  onRefresh,
  onClose
}: {
  data: BriefingData | null
  loading: boolean
  onRefresh: () => void
  onClose: () => void
}): JSX.Element {
  const [open, setOpen] = useState<Record<string, boolean>>({})
  const toggle = (k: string): void => setOpen((o) => ({ ...o, [k]: !o[k] }))

  return (
    <div className="dock-card">
      <div className="dock-card-head">
        <span className="dock-card-title">
          <Sunrise size={14} /> Ecosystem{data ? ` · ${timeAgo(data.generatedAt)}` : ''}
        </span>
        <div className="dock-card-actions">
          <button onClick={onRefresh} disabled={loading} title="Refresh">
            {loading ? <Loader2 size={14} className="spin" /> : <RefreshCw size={14} />}
          </button>
          <button onClick={onClose} title="Dismiss">
            <X size={14} />
          </button>
        </div>
      </div>

      <div className="dock-card-body">
        {loading && !data ? (
          <div className="brief-skel" aria-busy="true">
            {[0, 1].map((i) => (
              <div className="brief-skel-proj" key={i}>
                <div className="skel skel-line" style={{ width: '42%' }} />
                <div className="skel skel-line" style={{ width: '68%' }} />
                <div className="skel" style={{ height: 40 }} />
              </div>
            ))}
          </div>
        ) : !data || data.projects.length === 0 ? (
          <div className="dock-loading">No projects to brief — add repos in Projects.</div>
        ) : (
          data.projects.map((p) => {
            const detail = p.prs.length + p.dirty.length
            const isOpen = open[p.name]
            return (
              <div className="brief-proj" key={p.name}>
                <div className="brief-proj-head">
                  {p.url ? (
                    <a className="brief-proj-name link" href={p.url} target="_blank" rel="noreferrer" title="Open repo on GitHub">
                      {p.name}
                    </a>
                  ) : (
                    <span className="brief-proj-name">{p.name}</span>
                  )}
                  <span className="brief-spacer" />
                  <span className={`brief-status ${p.dirty.length ? 'dirty' : 'clean'}`}>
                    {p.dirty.length ? `${p.dirty.length} uncommitted` : 'clean'}
                  </span>
                </div>
                <div className="brief-proj-meta">
                  <span className="brief-chip">
                    <GitBranch size={10} /> {p.branch}
                  </span>
                  {p.activity7d > 0 && (
                    <span className="brief-chip dim">
                      <History size={10} /> {p.activity7d} commit{p.activity7d === 1 ? '' : 's'}/7d
                    </span>
                  )}
                </div>
                {p.lastCommit &&
                  (p.lastCommit.url ? (
                    <a className="brief-commit link" href={p.lastCommit.url} target="_blank" rel="noreferrer" title="View commit on GitHub">
                      <GitCommitHorizontal size={11} /> {p.lastCommit.text} <ExternalLink size={9} />
                    </a>
                  ) : (
                    <span className="brief-commit">
                      <GitCommitHorizontal size={11} /> {p.lastCommit.text}
                    </span>
                  ))}

                {p.analytics.length > 0 && (
                  <div className="brief-section">
                    <div className="brief-section-head">Analytics · GA4 · last 7 days</div>
                    {p.analytics.map((a) => (
                      <div className="brief-ga" key={a.label}>
                        <div className="brief-ga-label">{a.label}</div>
                        <div className="brief-kpis">
                          <Kpi n={a.users} d={a.delta.users} label="Users" />
                          <Kpi n={a.sessions} d={a.delta.sessions} label="Sessions" />
                          <Kpi n={a.views} d={a.delta.views} label="Views" />
                        </div>
                      </div>
                    ))}
                    <div className="brief-section-foot">vs previous 7 days</div>
                  </div>
                )}

                {detail > 0 && (
                  <button className="brief-toggle" onClick={() => toggle(p.name)}>
                    {isOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                    {p.prs.length} open PR{p.prs.length !== 1 ? 's' : ''}
                    {p.dirty.length ? ` · ${p.dirty.length} uncommitted` : ''}
                  </button>
                )}

                {isOpen && (
                  <div className="brief-detail">
                    {p.prs.map((pr) => (
                      <a className="brief-pr link" key={pr.number} href={pr.url} target="_blank" rel="noreferrer" title="Open PR on GitHub">
                        #{pr.number} {pr.title}
                        {pr.agent && <span className="brief-agent">agent</span>}
                        <ExternalLink size={10} />
                      </a>
                    ))}
                    {p.dirty.length > 0 && (
                      <div className="brief-dirty-group">
                        <span className="brief-dirty-label">Uncommitted</span>
                        {p.dirty.slice(0, 8).map((f) => (
                          <div className="brief-dirty" key={f}>
                            {f}
                          </div>
                        ))}
                        {p.dirty.length > 8 && <div className="brief-dirty">+{p.dirty.length - 8} more</div>}
                      </div>
                    )}
                  </div>
                )}
              </div>
            )
          })
        )}
      </div>
    </div>
  )
}

function Kpi({ n, d, label }: { n: number; d: number | null; label: string }): JSX.Element {
  return (
    <div className="kpi">
      <div className="kpi-top">
        <span className="kpi-num">{fmt(n)}</span>
        {d !== null && (
          <span className={`kpi-delta ${d > 0 ? 'up' : d < 0 ? 'down' : 'flat'}`}>
            {d > 0 ? '▲' : d < 0 ? '▼' : '–'}
            {Math.abs(d)}%
          </span>
        )}
      </div>
      <div className="kpi-label">{label}</div>
    </div>
  )
}

function fmt(n: number): string {
  return n.toLocaleString('en-US')
}

function timeAgo(ts: number): string {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000))
  if (s < 60) return 'just now'
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m ago`
  return `${Math.round(m / 60)}h ago`
}
