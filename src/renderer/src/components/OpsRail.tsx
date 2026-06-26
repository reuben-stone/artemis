import { useCallback, useEffect, useState, type ReactNode } from 'react'
import {
  GitPullRequest,
  RefreshCw,
  Maximize2,
  ExternalLink,
  LayoutGrid,
  GitMerge,
  CircleCheck,
  CircleX,
  Clock,
  MessageSquare,
  Volume2,
  Check,
  Send
} from 'lucide-react'
import { RailCard, type RailReorder } from './RailCard'
import type { PrReview, ProjectTicket, CommentNotification } from '../../../preload'

/** Compact live-outcome chips for a worker PR (merge state · CI · review). Shared by the
 *  rail PR card, the full PR queue, and the board's "PR open" tickets. Renders nothing until
 *  an outcome has been synced. */
export function PrOutcomeBadges({ p }: { p: PrReview }): JSX.Element | null {
  const chips: ReactNode[] = []
  if (p.state === 'merged') chips.push(<span key="m" className="hud-badge merged"><GitMerge size={9} /> merged</span>)
  else if (p.state === 'closed') chips.push(<span key="c" className="hud-badge closed">closed</span>)
  if (p.checks === 'success') chips.push(<span key="ci" className="hud-badge ok"><CircleCheck size={9} /> CI</span>)
  else if (p.checks === 'failure') chips.push(<span key="ci" className="hud-badge fail"><CircleX size={9} /> CI</span>)
  else if (p.checks === 'pending') chips.push(<span key="ci" className="hud-badge pend"><Clock size={9} /> CI</span>)
  if (p.reviewDecision === 'changes_requested') chips.push(<span key="rv" className="hud-badge fail">changes</span>)
  else if (p.reviewDecision === 'approved') chips.push(<span key="rv" className="hud-badge ok">approved</span>)
  if (!chips.length) return null
  return <span className="hud-pr-outcome">{chips}</span>
}

/** Issue numbers that already have a worker PR (matched on the artemis/ticket-<n> branch). */
export function ticketNumbersWithPr(prs: PrReview[]): Set<number> {
  const s = new Set<number>()
  for (const p of prs) {
    const m = p.branch?.match(/^artemis\/ticket-(\d+)/)
    if (m) s.add(Number(m[1]))
  }
  return s
}


/** Compact relative time from a ms timestamp (for notification headers). */
function relTime(ms: number): string {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000))
  if (s < 60) return 'just now'
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.round(m / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.round(h / 24)}d ago`
}

/** Map a status to a colour tone for the ticket card's left accent stripe (quick scanning). */
function statusTone(s?: string | null): string {
  const l = (s ?? '').toLowerCase()
  if (l.includes('progress') || l.includes('doing')) return 'prog'
  if (l.includes('review')) return 'review'
  if (l === 'todo' || l === 'to do') return 'todo'
  if (l.includes('triage')) return 'triage'
  if (l.includes('block')) return 'blocked'
  if (l.includes('backlog')) return 'backlog'
  if (l === 'done') return 'done'
  return 'none'
}

/** Order status columns actionable-first, Done last — so the eye lands on what needs doing. */
function statusSort(s: string): number {
  const l = s.toLowerCase()
  if (l.includes('progress')) return 0
  if (l === 'todo' || l === 'to do') return 1
  if (l.includes('triage')) return 2
  if (l === 'done') return 9
  return 5
}

/** A few shimmer placeholder lines, for a card's first async load. */
function Skeleton({ rows = 3 }: { rows?: number }): JSX.Element {
  return (
    <div className="hud-skel" aria-busy="true">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="skel skel-line" style={{ width: `${85 - (i % 3) * 18}%` }} />
      ))}
    </div>
  )
}

/**
 * The ops cards of the HUD rail — the mission anchor. Exposed as a hook (not a component)
 * so HudRail can interleave these with the day-planner cards in one user-orderable list.
 *   · PR Review — the worker-agent approval queue (cheap SQLite; refetches each turn).
 *   · Tickets — the cross-repo GitHub Projects board (compact card list + quick filters).
 *   · Notifications — new ticket comments across watched boards.
 * (The cross-repo ecosystem snapshot now lives in the on-demand Brief modal, not a rail card.)
 */

// Session cache so a renderer hot-reload / rail remount doesn't re-run the board's GraphQL
// sync. boardSynced gates the one network sync per session.
let boardCache: ProjectTicket[] | null = null
let boardSynced = false

export function useOpsCards({
  refreshSignal,
  onOpenPrs,
  onOpenBoard,
  onOpenNotifications,
  onSpeak,
  collapsed,
  hidden,
  onToggleCollapse,
  reorder
}: {
  refreshSignal: number
  onOpenPrs: () => void
  onOpenBoard: (ticket?: ProjectTicket) => void
  onOpenNotifications: () => void
  onSpeak: (text: string) => void
  collapsed: Record<string, boolean>
  hidden: Record<string, boolean>
  onToggleCollapse: (key: string) => void
  reorder: (key: string) => RailReorder
}): { prs: ReactNode; board: ReactNode; notifications: ReactNode } {
  const [prs, setPrs] = useState<PrReview[]>([])
  const [prSyncing, setPrSyncing] = useState(false)
  const [board, setBoard] = useState<ProjectTicket[]>(boardCache ?? [])
  const [boardLoading, setBoardLoading] = useState(false)
  const [boardError, setBoardError] = useState<string | null>(null)
  // Which board (by GitHub board title) to show — 'all' = every board. Shares the
  // BoardPanel's persistence key so the chosen board sticks across rail + full panel.
  const [boardFilter, setBoardFilter] = useState<string>(() => {
    try {
      return localStorage.getItem('artemis.board.filter') || 'all'
    } catch {
      return 'all'
    }
  })
  // Quick status filter for the Tickets card: '' = open (everything but Done), or a specific
  // status column. Clicking a status chip toggles it; clicking the active one clears back to open.
  const [statusFilter, setStatusFilter] = useState<string>('')
  const [notifs, setNotifs] = useState<CommentNotification[]>([])
  const [replyKey, setReplyKey] = useState<string | null>(null) // which notification's reply box is open
  const [replyText, setReplyText] = useState('')
  const [replying, setReplying] = useState(false)

  // PRs are a cheap SQLite read — safe to refetch whenever a turn settles.
  useEffect(() => {
    window.artemis?.prReviews?.list().then((p) => p && setPrs(p))
  }, [refreshSignal])

  // New ticket comments (cached during board sync) — refetch when a turn settles or board re-syncs.
  useEffect(() => {
    window.artemis?.notifications?.list().then((n) => n && setNotifs(n))
  }, [refreshSignal, board])

  const notifKey = (n: CommentNotification): string => `${n.project}#${n.issueNumber}@${n.createdAt}`

  const markNotifsRead = useCallback(async () => {
    const updated = await window.artemis?.notifications?.markRead()
    if (updated) setNotifs(updated)
  }, [])

  const replyToNotif = useCallback(
    async (n: CommentNotification) => {
      if (!replyText.trim() || n.issueNumber == null) return
      setReplying(true)
      try {
        const res = await window.artemis?.tickets?.comment({
          project: n.project,
          repo: n.repo,
          number: n.issueNumber,
          body: replyText.trim()
        })
        if (res?.ok) {
          setReplyKey(null)
          setReplyText('')
          const fresh = await window.artemis?.notifications?.list()
          if (fresh) setNotifs(fresh)
        }
      } finally {
        setReplying(false)
      }
    },
    [replyText]
  )

  const readNotifsAloud = useCallback(() => {
    if (!notifs.length) {
      onSpeak('No new comments on your boards.')
      return
    }
    const top = notifs.slice(0, 5)
    const lines = top.map((n) => `${n.author} on ticket ${n.issueNumber}: ${n.body.replace(/\s+/g, ' ').slice(0, 200)}`)
    const more = notifs.length > top.length ? ` And ${notifs.length - top.length} more.` : ''
    onSpeak(`${notifs.length} new comment${notifs.length === 1 ? '' : 's'} on your boards. ${lines.join('. ')}.${more}`)
  }, [notifs, onSpeak])

  // Tickets are a cheap SQLite read too — paint from cache on every settle.
  useEffect(() => {
    window.artemis?.tickets?.list().then((t) => {
      if (t) {
        setBoard(t)
        boardCache = t
      }
    })
  }, [refreshSignal])

  // Pull live PR outcomes (merge/CI/review) from GitHub — explicit, never on the turn loop.
  const syncPrs = useCallback(async () => {
    setPrSyncing(true)
    try {
      const updated = await window.artemis?.prReviews?.sync()
      if (updated) setPrs(updated)
    } finally {
      setPrSyncing(false)
    }
  }, [])

  // Re-sync the board from GitHub (GraphQL) — heavy, so explicit / once per session.
  const syncBoard = useCallback(async () => {
    setBoardLoading(true)
    setBoardError(null)
    try {
      const res = await window.artemis?.tickets?.sync()
      if (res) {
        setBoard(res.tickets)
        boardCache = res.tickets
        if (res.errors?.length) setBoardError(res.errors.join('; '))
      }
    } finally {
      setBoardLoading(false)
    }
  }, [])

  // One network board sync per session, when first shown (not if hidden).
  useEffect(() => {
    if (!boardSynced && !hidden.board) {
      boardSynced = true
      void syncBoard()
    }
  }, [syncBoard, hidden.board])

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
        <>
          <button className="hud-mini" onClick={() => void syncPrs()} title="Pull live merge/CI/review status" disabled={prSyncing}>
            <RefreshCw size={12} className={prSyncing ? 'spin' : ''} />
          </button>
          <button className="hud-mini" onClick={onOpenPrs} title="Open the full PR queue">
            <Maximize2 size={12} />
          </button>
        </>
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
              <PrOutcomeBadges p={p} />
            </a>
          </div>
        ))}
        {pending.length > 6 && <div className="hud-empty">+{pending.length - 6} more — open the full queue</div>}
      </div>
    </RailCard>
  )

  // The cross-repo TICKETS card — the north-star loop's ingest surface, as a compact card list.
  // Cheap paint from SQLite; the network sync (GraphQL) is explicit.
  const withPr = ticketNumbersWithPr(prs)
  // Distinct boards by GitHub board title — a monorepo is ONE project mapping to several
  // boards (Lumi/LumiLens), so we switch by board, never by project (which would merge them).
  const boardNames = [...new Set(board.map((t) => t.boardTitle).filter(Boolean))].sort() as string[]
  const isAllBoards = boardFilter === 'all'
  const visibleBoard = isAllBoards ? board : board.filter((t) => t.boardTitle === boardFilter)
  // Status counts (for the quick-filter chips), actionable-first.
  const statusCounts = new Map<string, number>()
  for (const t of visibleBoard) statusCounts.set(t.status || 'No status', (statusCounts.get(t.status || 'No status') ?? 0) + 1)
  const statusChips = [...statusCounts].sort((a, b) => statusSort(a[0]) - statusSort(b[0]))
  // The list: filtered by the active status chip (or "open" = everything but Done by default),
  // newest first so the freshest activity is on top, capped to a handful with a "show all" link.
  const filteredTickets = (
    statusFilter ? visibleBoard.filter((t) => (t.status || 'No status') === statusFilter) : visibleBoard.filter((t) => (t.status ?? '').toLowerCase() !== 'done')
  )
    .slice()
    .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
  const shownTickets = filteredTickets.slice(0, 6)

  const boardNode = (
    <RailCard
      icon={<LayoutGrid size={13} />}
      title={`Tickets${filteredTickets.length ? ` · ${filteredTickets.length}` : ''}`}
      collapsed={!!collapsed.board}
      onToggleCollapse={() => onToggleCollapse('board')}
      reorder={reorder('board')}
      actions={
        <>
          <button className="hud-mini" onClick={() => void syncBoard()} title="Re-sync tickets from GitHub" disabled={boardLoading}>
            <RefreshCw size={12} className={boardLoading ? 'spin' : ''} />
          </button>
          <button className="hud-mini" onClick={() => onOpenBoard()} title="Open the full board">
            <Maximize2 size={12} />
          </button>
        </>
      }
    >
      <div className="hud-tickets">
        {board.length === 0 && !boardLoading && !boardError && (
          <div className="hud-empty">No tickets. Configure a GitHub Projects board in Settings → Connections.</div>
        )}
        {board.length === 0 && boardLoading && <Skeleton rows={4} />}
        {boardError && <div className="hud-empty err">Board sync: {boardError}</div>}

        {board.length > 0 && (
          <>
            {/* Quick filters: board scope + status chips (click to filter, click again to clear). */}
            <div className="hud-tkt-filters">
              {boardNames.length > 1 && (
                <select
                  className="hud-tkt-board"
                  value={boardNames.includes(boardFilter) ? boardFilter : 'all'}
                  onChange={(e) => {
                    const v = e.target.value
                    setBoardFilter(v)
                    setStatusFilter('')
                    try {
                      localStorage.setItem('artemis.board.filter', v)
                    } catch {
                      /* private mode — non-fatal */
                    }
                  }}
                  title="Filter to one board"
                >
                  <option value="all">All boards ({board.length})</option>
                  {boardNames.map((name) => (
                    <option key={name} value={name}>
                      {name} ({board.filter((t) => t.boardTitle === name).length})
                    </option>
                  ))}
                </select>
              )}
              <div className="hud-tkt-chips">
                <button
                  className={`hud-fchip ${statusFilter === '' ? 'on' : ''}`}
                  onClick={() => setStatusFilter('')}
                  title="Open tickets (everything but Done)"
                >
                  Open
                </button>
                {statusChips.map(([s, n]) => (
                  <button
                    key={s}
                    className={`hud-fchip ${statusFilter === s ? 'on' : ''} ${s.toLowerCase() === 'done' ? 'dim' : ''}`}
                    onClick={() => setStatusFilter((cur) => (cur === s ? '' : s))}
                    title={`Filter to ${s}`}
                  >
                    {s} <span className="hud-fchip-n">{n}</span>
                  </button>
                ))}
              </div>
            </div>

            {/* Ticket cards — newest first; project/board label shown on the All-boards view. */}
            {shownTickets.length === 0 ? (
              <div className="hud-empty">No tickets {statusFilter ? `in ${statusFilter}` : 'open'}.</div>
            ) : (
              shownTickets.map((t) => (
                <button
                  key={t.id}
                  className={`hud-tkt-card tone-${statusTone(t.status)}`}
                  onClick={() => onOpenBoard(t)}
                  title={t.repo ? `${t.repo} — ${t.title}` : t.title}
                >
                  <div className="hud-tkt-head">
                    <span className="hud-tkt-num">{t.issueNumber != null ? `#${t.issueNumber}` : '·'}</span>
                    {isAllBoards && t.boardTitle && <span className="hud-tkt-board-chip">{t.boardTitle}</span>}
                    {t.status && <span className="hud-tkt-status">{t.status}</span>}
                    <span className="hud-tkt-spacer" />
                    {t.issueNumber != null && withPr.has(t.issueNumber) && (
                      <span className="hud-badge ok" title="A worker PR is open for this ticket">
                        <GitPullRequest size={9} /> PR
                      </span>
                    )}
                  </div>
                  <div className="hud-tkt-title">{t.title}</div>
                </button>
              ))
            )}

            <button className="hud-tkt-all" onClick={() => onOpenBoard()}>
              {filteredTickets.length > shownTickets.length ? `Show all ${filteredTickets.length} →` : 'Open full board →'}
            </button>
          </>
        )}
      </div>
    </RailCard>
  )

  // New ticket comments across watched boards — read aloud, reply inline, or mark read.
  const notificationsNode = (
    <RailCard
      icon={<MessageSquare size={13} />}
      title={`Notifications${notifs.length ? ` · ${notifs.length}` : ''}`}
      collapsed={!!collapsed.notifications}
      onToggleCollapse={() => onToggleCollapse('notifications')}
      reorder={reorder('notifications')}
      actions={
        <>
          <button className="hud-mini" onClick={readNotifsAloud} title="Read new comments aloud" disabled={!notifs.length}>
            <Volume2 size={12} />
          </button>
          <button className="hud-mini" onClick={() => void markNotifsRead()} title="Mark all read" disabled={!notifs.length}>
            <Check size={12} />
          </button>
          <button className="hud-mini" onClick={onOpenNotifications} title="Open the full notifications view">
            <Maximize2 size={12} />
          </button>
        </>
      }
    >
      <div className="hud-list">
        {notifs.length === 0 && <div className="hud-empty">No new comments. Sync a board to check.</div>}
        {notifs.map((n) => {
          const key = notifKey(n)
          return (
            <div key={key} className="hud-notif">
              <div className="hud-notif-head">
                <span className="hud-notif-author">{n.author}</span>
                <span className="hud-notif-meta">
                  {n.boardTitle ? `${n.boardTitle} ` : ''}#{n.issueNumber} · {relTime(n.createdAt)}
                </span>
              </div>
              <button
                className="hud-notif-body"
                onClick={() => onOpenBoard(board.find((t) => t.project === n.project && t.issueNumber === n.issueNumber))}
                title={`${n.ticketTitle} — open ticket`}
              >
                {n.body.replace(/\s+/g, ' ').slice(0, 140)}
              </button>
              {replyKey === key ? (
                <div className="hud-notif-reply">
                  <textarea
                    value={replyText}
                    onChange={(e) => setReplyText(e.target.value)}
                    rows={2}
                    placeholder="Reply…"
                    autoFocus
                  />
                  <div className="hud-notif-reply-actions">
                    <button className="hud-mini" disabled={replying || !replyText.trim()} onClick={() => void replyToNotif(n)} title="Post reply">
                      <Send size={12} />
                    </button>
                    <button className="hud-mini" disabled={replying} onClick={() => setReplyKey(null)} title="Cancel">
                      <CircleX size={12} />
                    </button>
                  </div>
                </div>
              ) : (
                <button
                  className="hud-notif-replybtn"
                  onClick={() => {
                    setReplyKey(key)
                    setReplyText('')
                  }}
                >
                  Reply
                </button>
              )}
            </div>
          )
        })}
      </div>
    </RailCard>
  )

  return { prs: prsNode, board: boardNode, notifications: notificationsNode }
}
