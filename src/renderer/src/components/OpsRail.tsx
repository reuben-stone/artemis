import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { GitPullRequest, Boxes, RefreshCw, Maximize2, ExternalLink, GitBranch, GitCommitHorizontal } from 'lucide-react'
import { RailCard, type RailReorder } from './RailCard'
import type { PrReview, BriefingData } from '../../../preload'

/**
 * The ops cards of the HUD rail — the mission anchor. Exposed as a hook (not a component)
 * so HudRail can interleave these with the day-planner cards in one user-orderable list.
 *   · PR Review — the worker-agent approval queue (cheap SQLite; refetches each turn).
 *   · Ecosystem — a cross-repo health snapshot (branch/dirty/PRs). The briefing gather is
 *     heavy (git across every repo), so it's lazy + session-cached, never on the turn loop.
 */

// Session cache so a renderer hot-reload / rail remount doesn't re-run the heavy git sweep.
let ecoCache: BriefingData | null = null

export function useOpsCards({
  refreshSignal,
  onOpenPrs,
  onOpenBriefing,
  collapsed,
  hidden,
  onToggleCollapse,
  reorder
}: {
  refreshSignal: number
  onOpenPrs: () => void
  onOpenBriefing: () => void
  collapsed: Record<string, boolean>
  hidden: Record<string, boolean>
  onToggleCollapse: (key: string) => void
  reorder: (key: string) => RailReorder
}): { prs: ReactNode; ecosystem: ReactNode } {
  const [prs, setPrs] = useState<PrReview[]>([])
  const [eco, setEco] = useState<BriefingData | null>(ecoCache)
  const [ecoLoading, setEcoLoading] = useState(false)

  // PRs are a cheap SQLite read — safe to refetch whenever a turn settles.
  useEffect(() => {
    window.artemis?.prReviews?.list().then((p) => p && setPrs(p))
  }, [refreshSignal])

  const loadEco = useCallback(async () => {
    setEcoLoading(true)
    try {
      const d = await window.artemis?.briefing?.data()
      if (d) {
        ecoCache = d
        setEco(d)
      }
    } finally {
      setEcoLoading(false)
    }
  }, [])

  // Load the ecosystem snapshot once per session (cached) — and not at all if it's hidden.
  useEffect(() => {
    if (!ecoCache && !hidden.ecosystem) void loadEco()
  }, [loadEco, hidden.ecosystem])

  const togglePr = useCallback(async (id: number, reviewed: boolean) => {
    const updated = await window.artemis?.prReviews?.setReviewed(id, reviewed)
    if (updated) setPrs(updated)
  }, [])

  const pending = prs.filter((p) => !p.reviewed)

  const prsNode = (
    <RailCard
      icon={<GitPullRequest size={13} />}
      title={`PR Review${pending.length ? ` · ${pending.length}` : ''}`}
      collapsed={!!collapsed.prs}
      onToggleCollapse={() => onToggleCollapse('prs')}
      reorder={reorder('prs')}
      actions={
        <button className="hud-mini" onClick={onOpenPrs} title="Open the full PR queue">
          <Maximize2 size={12} />
        </button>
      }
    >
      <div className="hud-list">
        {prs.length === 0 && <div className="hud-empty">No PRs awaiting review — worker agents log theirs here.</div>}
        {pending.slice(0, 6).map((p) => (
          <div key={p.id} className="hud-pr">
            <input type="checkbox" checked={false} onChange={() => void togglePr(p.id, true)} title="Mark reviewed" />
            <a className="hud-pr-body" href={p.url} target="_blank" rel="noreferrer" title="Open on GitHub">
              <span className="hud-pr-title">{p.title}</span>
              <span className="hud-pr-meta">
                {p.project}
                <ExternalLink size={10} />
              </span>
            </a>
          </div>
        ))}
        {pending.length > 6 && <div className="hud-empty">+{pending.length - 6} more — open the full queue</div>}
      </div>
    </RailCard>
  )

  const ecosystemNode = (
    <RailCard
      icon={<Boxes size={13} />}
      title="Ecosystem"
      collapsed={!!collapsed.ecosystem}
      onToggleCollapse={() => onToggleCollapse('ecosystem')}
      reorder={reorder('ecosystem')}
      actions={
        <>
          <button className="hud-mini" onClick={() => void loadEco()} title="Refresh" disabled={ecoLoading}>
            <RefreshCw size={12} className={ecoLoading ? 'spin' : ''} />
          </button>
          <button className="hud-mini" onClick={onOpenBriefing} title="Open the full briefing">
            <Maximize2 size={12} />
          </button>
        </>
      }
    >
      <div className="hud-list">
        {!eco && ecoLoading && <div className="hud-empty">Gathering ecosystem status…</div>}
        {!eco && !ecoLoading && <div className="hud-empty">No data yet — refresh to load.</div>}
        {eco?.projects.length === 0 && <div className="hud-empty">No overseen repos registered.</div>}
        {eco?.projects.map((p) => (
          <div key={p.name} className="hud-eco">
            <div className="hud-eco-top">
              {p.url ? (
                <a className="hud-eco-name link" href={p.url} target="_blank" rel="noreferrer" title="Open repo on GitHub">
                  {p.name}
                </a>
              ) : (
                <span className="hud-eco-name">{p.name}</span>
              )}
              <span className={`hud-eco-branch ${p.dirty.length ? 'dirty' : ''}`} title={p.branch ?? ''}>
                <GitBranch size={10} />
                <span className="hud-eco-branch-name">{p.branch ?? '—'}</span>
              </span>
            </div>
            <div className="hud-eco-meta">
              {p.dirty.length > 0 && <span className="hud-eco-chip warn">{p.dirty.length} uncommitted</span>}
              {p.dirty.length === 0 && <span className="hud-eco-chip">clean</span>}
              {p.prs.length > 0 &&
                (p.url ? (
                  <a className="hud-eco-chip link" href={`${p.url}/pulls`} target="_blank" rel="noreferrer" title="Open PRs on GitHub">
                    {p.prs.length} open PR{p.prs.length === 1 ? '' : 's'}
                  </a>
                ) : (
                  <span className="hud-eco-chip">{p.prs.length} open PR{p.prs.length === 1 ? '' : 's'}</span>
                ))}
              <span className="hud-eco-chip dim">{p.activity7d} commit{p.activity7d === 1 ? '' : 's'}/7d</span>
            </div>
            {p.lastCommit &&
              (p.lastCommit.url ? (
                <a className="hud-eco-commit link" href={p.lastCommit.url} target="_blank" rel="noreferrer" title={p.lastCommit.text}>
                  <GitCommitHorizontal size={10} />
                  <span className="hud-eco-commit-text">{p.lastCommit.text}</span>
                </a>
              ) : (
                <span className="hud-eco-commit" title={p.lastCommit.text}>
                  <GitCommitHorizontal size={10} />
                  <span className="hud-eco-commit-text">{p.lastCommit.text}</span>
                </span>
              ))}
          </div>
        ))}
      </div>
    </RailCard>
  )

  return { prs: prsNode, ecosystem: ecosystemNode }
}
