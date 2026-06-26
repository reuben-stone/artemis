import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkBreaks from 'remark-breaks'
import {
  X,
  RefreshCw,
  ExternalLink,
  GitPullRequest,
  Rocket,
  LayoutGrid,
  Tag,
  User,
  ChevronLeft,
  CheckCircle2,
  CircleDot,
  Plus,
  FilePen,
  Pencil,
  Trash2
} from 'lucide-react'
import type { Project, ProjectTicket, PrReview, TicketDetail, TicketComment } from '../../../preload'
import { ticketNumbersWithPr } from './OpsRail'

/**
 * The cross-repo ticket board — the full view of the north-star loop's ingest surface.
 * Tickets are pulled from GitHub Projects (v2), grouped by status column. A board switcher
 * filters to one mapped board when several exist. Selecting a ticket opens an in-app detail
 * view where you can edit it (title/body), move its Status column, close/reopen it, or
 * dispatch a worker — each a gated GitHub write that re-syncs the board on success.
 */

const STATUS_RANK: Record<string, number> = {
  todo: 0,
  'to do': 0,
  backlog: 1,
  'in progress': 2,
  doing: 2,
  'in review': 3,
  review: 3,
  blocked: 4,
  done: 9
}
function statusRank(s: string): number {
  return STATUS_RANK[s.toLowerCase()] ?? 5
}

/** Compact relative time from an ISO timestamp, for comment headers. */
function relativeTime(iso: string): string {
  const t = Date.parse(iso)
  if (!iso || isNaN(t)) return ''
  const s = Math.max(0, Math.round((Date.now() - t) / 1000))
  if (s < 60) return 'just now'
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.round(m / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.round(h / 24)}d ago`
}

export function BoardPanel({
  projects,
  initialTicket,
  initialBoard,
  initialTicketNumber,
  onChanged,
  onClose
}: {
  projects: Project[]
  initialTicket?: ProjectTicket | null // open straight into this ticket's detail (from the rail)
  initialBoard?: string | null // open filtered to this board name (e.g. "Lumi", from the agent)
  initialTicketNumber?: number | null // open straight into this ticket # (from the agent's show_panel)
  onChanged: () => void
  onClose: () => void
}): JSX.Element {
  const [tickets, setTickets] = useState<ProjectTicket[]>([])
  const [prs, setPrs] = useState<PrReview[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)
  // Which board (by its GitHub title) to show — 'all' or a board name. Seeds from the agent's
  // requested board, the ticket we opened on, or the last-viewed board (persisted).
  const [filter, setFilter] = useState<string>(
    () => initialBoard || initialTicket?.boardTitle || localStorage.getItem('artemis.board.filter') || 'all'
  )
  const appliedInitialBoard = useRef(false)
  const appliedInitialTicket = useRef(false)

  // In-app detail/edit view for one ticket, and the "+ New ticket" create view.
  const [selected, setSelected] = useState<ProjectTicket | null>(initialTicket ?? null)
  const [creating, setCreating] = useState(false)
  const [dragId, setDragId] = useState<number | null>(null) // ticket being dragged
  const [dragOverCol, setDragOverCol] = useState<string | null>(null)

  const load = useCallback(async () => {
    const [t, p] = await Promise.all([window.artemis?.tickets?.list(), window.artemis?.prReviews?.list()])
    if (t) setTickets(t)
    if (p) setPrs(p)
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const sync = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await window.artemis?.tickets?.sync()
      if (res) {
        setTickets(res.tickets)
        if (res.errors?.length) setError(res.errors.join('; '))
      }
      onChanged()
    } finally {
      setLoading(false)
    }
  }, [onChanged])

  const anyBoardConfigured = projects.some((p) => p.boards.length > 0)
  const withPr = useMemo(() => ticketNumbersWithPr(prs), [prs])
  // Distinct BOARD names (a project can have several — Lumi, LumiLens) so each is its own filter,
  // not merged under the project.
  const boardNames = useMemo(
    () => [...new Set(tickets.map((t) => t.boardTitle).filter((b): b is string => !!b))].sort(),
    [tickets]
  )
  // Resolve the agent's requested board (e.g. "lumi") to the canonical title once tickets load.
  useEffect(() => {
    if (appliedInitialBoard.current || !initialBoard || !boardNames.length) return
    const m = boardNames.find((b) => b.toLowerCase() === initialBoard.toLowerCase())
    if (m) {
      setFilter(m)
      appliedInitialBoard.current = true
    }
  }, [initialBoard, boardNames])
  // The agent asked to open a specific ticket (show_panel ticket:N) — once tickets load, find
  // it (disambiguated by initialBoard if given) and drop straight into its detail view.
  useEffect(() => {
    if (appliedInitialTicket.current || initialTicketNumber == null || !tickets.length) return
    let cands = tickets.filter((t) => t.issueNumber === initialTicketNumber)
    if (initialBoard) cands = cands.filter((t) => (t.boardTitle ?? '').toLowerCase() === initialBoard.toLowerCase())
    const hit = cands[0]
    if (hit) {
      if (hit.boardTitle) setFilter(hit.boardTitle)
      setSelected(hit)
      appliedInitialTicket.current = true
    }
  }, [initialTicketNumber, initialBoard, tickets])
  // Persist the last-viewed board so reopening the panel restores it.
  useEffect(() => {
    localStorage.setItem('artemis.board.filter', filter)
  }, [filter])
  // The board's status columns — distinct statuses in use (for the move-to dropdown).
  const statusOptions = useMemo(
    () => [...new Set(tickets.map((t) => t.status).filter((s): s is string => !!s))],
    [tickets]
  )

  const visible = filter === 'all' ? tickets : tickets.filter((t) => t.boardTitle === filter)
  // Leaving a ticket → return to the board that ticket was on, not "all boards".
  const backToBoard = (): void => {
    if (selected?.boardTitle) setFilter(selected.boardTitle)
    setSelected(null)
    setCreating(false)
  }

  // The board's FULL column set in its real GitHub order — from each in-view board's cached
  // Status options (captured on sync). This is what lets us render EMPTY columns as drop targets.
  const boardColumns = useMemo(() => {
    const cfgs = projects.flatMap((p) => p.boards)
    const inView = filter === 'all' ? cfgs : cfgs.filter((b) => b.title === filter)
    const names: string[] = []
    for (const b of inView) for (const o of b.statusOptions ?? []) if (!names.includes(o.name)) names.push(o.name)
    return names
  }, [projects, filter])

  // Group the visible tickets into status columns. Seed with the board's full column list so
  // empty columns still show (and can receive a dragged ticket); honour the board's own order
  // when we have it, else fall back to the rank heuristic.
  const columns = useMemo(() => {
    const map = new Map<string, ProjectTicket[]>()
    for (const name of boardColumns) map.set(name, []) // empty columns as drop targets
    for (const t of visible) {
      const k = t.status || 'No status'
      if (!map.has(k)) map.set(k, [])
      map.get(k)!.push(t)
    }
    const entries = [...map.entries()]
    if (boardColumns.length) {
      return entries.sort((a, b) => {
        const ia = boardColumns.indexOf(a[0])
        const ib = boardColumns.indexOf(b[0])
        // Columns not in the board config (e.g. "No status") sink to the end.
        return (ia === -1 ? 900 : ia) - (ib === -1 ? 900 : ib) || a[0].localeCompare(b[0])
      })
    }
    return entries.sort((a, b) => {
      const r = statusRank(a[0]) - statusRank(b[0])
      return r !== 0 ? r : a[0].localeCompare(b[0])
    })
  }, [visible, boardColumns])

  // After an in-app write, re-pull the cached board + PRs so the view reflects it.
  const refreshAfterWrite = useCallback(async () => {
    await load()
    onChanged()
  }, [load, onChanged])

  // Drag a card onto another column → set its Status column (like the real GitHub board).
  // Optimistic: move it locally first, then persist; revert on failure.
  const moveTicket = useCallback(
    async (t: ProjectTicket, toStatus: string) => {
      if (!toStatus || toStatus === 'No status' || t.status === toStatus || t.issueNumber == null) return
      setTickets((prev) => prev.map((x) => (x.id === t.id ? { ...x, status: toStatus } : x)))
      const res = await window.artemis?.tickets?.update({
        project: t.project,
        repo: t.repo,
        number: t.issueNumber,
        itemId: t.itemId,
        boardId: t.boardId,
        patch: { status: toStatus }
      })
      if (res?.ok) {
        setTickets(res.tickets)
        onChanged()
      } else {
        setError(`Could not move #${t.issueNumber}: ${res?.error ?? 'failed'}`)
        await load() // revert the optimistic move
      }
    },
    [load, onChanged]
  )

  return (
    <div className="projects-overlay" onClick={onClose}>
      <div className="projects-panel board-modal" onClick={(e) => e.stopPropagation()}>
        <div className="board-head">
          <span className="board-head-title">
            {selected || creating ? (
              <button className="board-back" onClick={backToBoard} title="Back to the board">
                <ChevronLeft size={16} /> {creating ? 'New ticket' : filter !== 'all' ? filter : 'Board'}
              </button>
            ) : (
              <>
                <LayoutGrid size={15} /> {filter !== 'all' ? filter : 'Ticket board'}
                <span className="board-head-count">
                  {visible.length} ticket{visible.length === 1 ? '' : 's'}
                </span>
              </>
            )}
          </span>
          <div className="board-head-actions">
            {!selected && !creating && (
              <>
                {boardNames.length > 1 && (
                  <select className="voice-select" style={{ maxWidth: 200 }} value={filter} onChange={(e) => setFilter(e.target.value)}>
                    <option value="all">All boards ({tickets.length})</option>
                    {boardNames.map((name) => (
                      <option key={name} value={name}>
                        {name} ({tickets.filter((t) => t.boardTitle === name).length})
                      </option>
                    ))}
                  </select>
                )}
                {projects.some((p) => p.boards.length > 0) && (
                  <button onClick={() => setCreating(true)} title="File a new ticket on a board">
                    <Plus size={14} /> New
                  </button>
                )}
              </>
            )}
            <button onClick={() => void sync()} title="Re-sync from GitHub" disabled={loading}>
              <RefreshCw size={14} className={loading ? 'spin' : ''} /> Sync
            </button>
            <button onClick={onClose} title="Close">
              <X size={15} />
            </button>
          </div>
        </div>

        {error && <div className="board-banner err">Board sync: {error}</div>}
        {note && !selected && <div className="board-banner">{note}</div>}

        {creating ? (
          <CreateTicketView
            projects={projects}
            tickets={tickets}
            defaultBoard={filter !== 'all' ? filter : ''}
            onCreated={refreshAfterWrite}
            onDone={() => setCreating(false)}
          />
        ) : selected ? (
          <TicketDetailView
            ticket={selected}
            statusOptions={statusOptions}
            hasPr={selected.issueNumber != null && withPr.has(selected.issueNumber)}
            onChanged={refreshAfterWrite}
            onClose={backToBoard}
          />
        ) : (
          <>
            {tickets.length === 0 && !loading && (
              <div className="board-empty">
                {anyBoardConfigured ? (
                  <>
                    No tickets cached yet. Hit <strong>Sync</strong> to pull the board from GitHub.
                  </>
                ) : (
                  <>
                    No GitHub Projects board is configured. Open <strong>Settings → Connections</strong> and map a board
                    to a project, then Sync.
                    <div className="board-empty-note">
                      Projects v2 needs the gh <code>project</code> scope — run <code>gh auth refresh -s read:project,project</code> once.
                    </div>
                  </>
                )}
              </div>
            )}

            {tickets.length === 0 && loading && (
              <div className="board-columns" aria-busy="true">
                {[0, 1, 2].map((c) => (
                  <div className="board-col" key={c}>
                    <div className="skel skel-line" style={{ width: '55%', margin: '4px 2px 8px' }} />
                    {[0, 1, 2].map((i) => (
                      <div className="skel" key={i} style={{ height: 54 }} />
                    ))}
                  </div>
                ))}
              </div>
            )}

            <div className="board-columns">
              {columns.map(([status, ts]) => (
                <div
                  className={`board-col ${dragOverCol === status ? 'drag-over' : ''}`}
                  key={status}
                  onDragOver={(e) => {
                    if (dragId != null && status !== 'No status') {
                      e.preventDefault()
                      if (dragOverCol !== status) setDragOverCol(status)
                    }
                  }}
                  onDragLeave={() => setDragOverCol((c) => (c === status ? null : c))}
                  onDrop={() => {
                    const t = tickets.find((x) => x.id === dragId)
                    setDragOverCol(null)
                    if (t) void moveTicket(t, status)
                  }}
                >
                  <div className="board-col-head">
                    {status} <span className="board-col-count">{ts.length}</span>
                  </div>
                  {ts.map((t) => {
                    const hasPr = t.issueNumber != null && withPr.has(t.issueNumber)
                    return (
                      <button
                        className={`board-card ${dragId === t.id ? 'dragging' : ''}`}
                        key={t.id}
                        draggable
                        onDragStart={(e) => {
                          setDragId(t.id)
                          e.dataTransfer.effectAllowed = 'move'
                        }}
                        onDragEnd={() => {
                          setDragId(null)
                          setDragOverCol(null)
                        }}
                        onClick={() => setSelected(t)}
                        title="Open ticket detail · drag to move column"
                      >
                        <div className="board-card-title">
                          {t.issueNumber != null && <span className="board-card-num">#{t.issueNumber}</span>}
                          {t.title}
                        </div>
                        <div className="board-card-meta">
                          {t.repo && <span className="board-chip repo">{t.repo}</span>}
                          {t.assignees && (
                            <span className="board-chip" title={t.assignees}>
                              <User size={9} /> {t.assignees.split(',')[0].trim()}
                              {t.assignees.includes(',') ? '…' : ''}
                            </span>
                          )}
                          {t.labels &&
                            t.labels
                              .split(',')
                              .slice(0, 3)
                              .map((l) => (
                                <span className="board-chip label" key={l}>
                                  <Tag size={9} /> {l.trim()}
                                </span>
                              ))}
                          {hasPr && (
                            <span className="board-chip pr" title="A worker PR is open for this ticket">
                              <GitPullRequest size={9} /> PR open
                            </span>
                          )}
                        </div>
                      </button>
                    )
                  })}
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  )
}

/** Detail + edit view for one ticket — title/body, move Status column, close/reopen, dispatch. */
function TicketDetailView({
  ticket,
  statusOptions,
  hasPr,
  onChanged,
  onClose
}: {
  ticket: ProjectTicket
  statusOptions: string[]
  hasPr: boolean
  onChanged: () => void | Promise<void>
  onClose: () => void
}): JSX.Element {
  const [detail, setDetail] = useState<TicketDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [title, setTitle] = useState(ticket.title)
  const [body, setBody] = useState('')
  const [status, setStatus] = useState(ticket.status ?? '')
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  const [dispatchOpen, setDispatchOpen] = useState(false)
  const [editing, setEditing] = useState(false) // read view by default; toggle to edit title/body
  const [comment, setComment] = useState('') // reply composer
  const [commenting, setCommenting] = useState(false)
  const [editingCommentId, setEditingCommentId] = useState<string | null>(null) // comment being edited
  const [commentDraft, setCommentDraft] = useState('') // edit-in-place buffer
  const [commentBusy, setCommentBusy] = useState(false)

  // Options for the move-to dropdown: the board's columns + the current one if missing.
  const options = useMemo(
    () => [...new Set([ticket.status, ...statusOptions].filter((s): s is string => !!s))],
    [ticket.status, statusOptions]
  )

  useEffect(() => {
    let live = true
    setLoading(true)
    void (async () => {
      const res = await window.artemis?.tickets?.detail(ticket.project, ticket.repo, ticket.issueNumber ?? -1)
      if (!live) return
      if (res?.ok) {
        setDetail(res.detail)
        setTitle(res.detail.title)
        setBody(res.detail.body)
      } else {
        setNote(res?.error ?? 'Could not load the ticket.')
      }
      setLoading(false)
    })()
    return () => {
      live = false
    }
  }, [ticket.project, ticket.issueNumber])

  const closed = detail?.state === 'closed'
  // Status applies immediately (its own action), so Save only concerns title/body.
  const dirty = detail != null && (title !== detail.title || body !== detail.body)

  const update = async (patch: { title?: string; body?: string; state?: 'open' | 'closed'; status?: string }, msg: string): Promise<void> => {
    if (ticket.issueNumber == null) return
    setBusy(true)
    setNote(null)
    try {
      const res = await window.artemis?.tickets?.update({
        project: ticket.project,
        repo: ticket.repo,
        number: ticket.issueNumber,
        itemId: ticket.itemId,
        boardId: ticket.boardId,
        patch
      })
      if (res?.ok) {
        setNote(msg)
        if (patch.title != null || patch.body != null) setDetail((d) => (d ? { ...d, ...patch } : d))
        if (patch.state) setDetail((d) => (d ? { ...d, state: patch.state! } : d))
        await onChanged()
      } else {
        setNote(`⚠ ${res?.error ?? 'Update failed.'}`)
      }
    } finally {
      setBusy(false)
    }
  }

  const save = (): Promise<void> => {
    const patch: { title?: string; body?: string } = {}
    if (detail && title !== detail.title) patch.title = title
    if (detail && body !== detail.body) patch.body = body
    if (!Object.keys(patch).length) return Promise.resolve()
    return update(patch, '✓ Saved.')
  }

  // Changing the Status column is its own immediate action (no "Save" needed).
  const changeStatus = (v: string): void => {
    setStatus(v)
    void update({ status: v }, `✓ Moved to ${v || 'No status'}.`)
  }

  // Post a comment, then show the refreshed thread (the IPC returns updated detail).
  const postComment = async (): Promise<void> => {
    if (!comment.trim() || ticket.issueNumber == null) return
    setCommenting(true)
    setNote(null)
    try {
      const res = await window.artemis?.tickets?.comment({
        project: ticket.project,
        repo: ticket.repo,
        number: ticket.issueNumber,
        body: comment.trim()
      })
      if (res?.ok) {
        setDetail(res.detail)
        setComment('')
        setNote('✓ Comment posted.')
      } else {
        setNote(`⚠ ${res?.error ?? 'Could not post comment.'}`)
      }
    } finally {
      setCommenting(false)
    }
  }

  // Edit one of your own comments in place; the IPC returns the refreshed thread.
  const saveCommentEdit = async (c: TicketComment): Promise<void> => {
    if (!commentDraft.trim() || ticket.issueNumber == null) return
    setCommentBusy(true)
    setNote(null)
    try {
      const res = await window.artemis?.tickets?.editComment({
        project: ticket.project,
        repo: ticket.repo,
        number: ticket.issueNumber,
        commentId: c.id,
        body: commentDraft.trim()
      })
      if (res?.ok) {
        setDetail(res.detail)
        setEditingCommentId(null)
        setNote('✓ Comment updated.')
      } else {
        setNote(`⚠ ${res?.error ?? 'Could not edit the comment.'}`)
      }
    } finally {
      setCommentBusy(false)
    }
  }

  // Delete one of your own comments (confirm first — it's irreversible on GitHub).
  const removeComment = async (c: TicketComment): Promise<void> => {
    if (ticket.issueNumber == null) return
    if (!window.confirm('Delete this comment? This cannot be undone.')) return
    setCommentBusy(true)
    setNote(null)
    try {
      const res = await window.artemis?.tickets?.deleteComment({
        project: ticket.project,
        repo: ticket.repo,
        number: ticket.issueNumber,
        commentId: c.id
      })
      if (res?.ok) {
        setDetail(res.detail)
        if (editingCommentId === c.id) setEditingCommentId(null)
        setNote('✓ Comment deleted.')
      } else {
        setNote(`⚠ ${res?.error ?? 'Could not delete the comment.'}`)
      }
    } finally {
      setCommentBusy(false)
    }
  }

  return (
    <div className="board-detail">
      <div className="board-detail-top">
        <span className="board-detail-num">{ticket.issueNumber != null ? `#${ticket.issueNumber}` : 'draft'}</span>
        {ticket.boardTitle && (
          <span className="board-chip board-name" title="The Projects board this ticket is on">
            <LayoutGrid size={9} /> {ticket.boardTitle}
          </span>
        )}
        {ticket.repo && (
          <span className="board-chip repo" title="The repo this issue lives in (may differ from the board's project)">
            {ticket.repo}
          </span>
        )}
        <span className={`board-chip ${closed ? '' : 'pr'}`}>{closed ? 'closed' : 'open'}</span>
        {hasPr && (
          <span className="board-chip pr">
            <GitPullRequest size={9} /> PR open
          </span>
        )}
        {ticket.url && (
          <a className="board-detail-gh" href={ticket.url} target="_blank" rel="noreferrer" title="Open on GitHub">
            GitHub <ExternalLink size={11} />
          </a>
        )}
      </div>

      {loading ? (
        <div className="board-detail-form" aria-busy="true">
          <div className="skel skel-line" style={{ width: '30%' }} />
          <div className="skel" style={{ height: 32 }} />
          <div className="skel skel-line" style={{ width: '22%', marginTop: 10 }} />
          <div className="skel" style={{ height: 32, width: 170 }} />
          <div className="skel skel-line" style={{ width: '28%', marginTop: 10 }} />
          <div className="skel" style={{ height: 150 }} />
        </div>
      ) : (
        <div className="board-detail-content">
          {/* Title — a heading when reading, a full-width input when editing. */}
          {editing ? (
            <input
              className="ollama-field board-title-input"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Issue title"
              spellCheck={false}
            />
          ) : (
            <h2 className="board-detail-title">{detail?.title ?? ticket.title}</h2>
          )}

          {/* Status (immediate) + assignees + labels in one tidy meta row. */}
          <div className="board-detail-metarow">
            <span className="board-detail-metalabel">Status</span>
            <select
              className="voice-select"
              value={status}
              disabled={busy}
              onChange={(e) => changeStatus(e.target.value)}
              style={{ minWidth: 150 }}
            >
              <option value="">No status</option>
              {options.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
            {detail?.assignees.map((a) => (
              <span className="board-chip" key={a}>
                <User size={9} /> {a}
              </span>
            ))}
            {detail?.labels.map((l) => (
              <span className="board-chip label" key={l}>
                <Tag size={9} /> {l}
              </span>
            ))}
          </div>

          {/* Body — rendered markdown when reading, a tall editor when editing. */}
          {editing ? (
            <textarea
              className="board-detail-body"
              value={body}
              onChange={(e) => setBody(e.target.value)}
              rows={16}
              placeholder="Describe the issue (markdown)…"
            />
          ) : (
            <div className="board-detail-md md">
              {(detail?.body ?? '').trim() ? (
                <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]}>{detail!.body}</ReactMarkdown>
              ) : (
                <span className="board-detail-empty-body">No description.</span>
              )}
            </div>
          )}

          {/* Right-sized action bar — Edit/Dispatch/Close while reading; Save/Cancel while editing. */}
          <div className="board-detail-actions">
            {editing ? (
              <>
                <button className="board-btn primary" disabled={busy || !dirty} onClick={() => void save().then(() => setEditing(false))}>
                  {busy ? 'Saving…' : 'Save'}
                </button>
                <button
                  className="board-btn"
                  disabled={busy}
                  onClick={() => {
                    setTitle(detail?.title ?? '')
                    setBody(detail?.body ?? '')
                    setEditing(false)
                  }}
                >
                  Cancel
                </button>
              </>
            ) : (
              <>
                <button className="board-btn" onClick={() => setEditing(true)}>
                  <FilePen size={12} /> Edit
                </button>
                {ticket.issueNumber != null && (
                  <button className="board-btn" onClick={() => setDispatchOpen(true)} title="Dispatch a worker at this ticket">
                    <Rocket size={12} /> Dispatch worker
                  </button>
                )}
                <button
                  className="board-btn"
                  disabled={busy}
                  onClick={() => void update({ state: closed ? 'open' : 'closed' }, closed ? '✓ Reopened.' : '✓ Closed.')}
                  title={closed ? 'Reopen the issue' : 'Close the issue'}
                >
                  {closed ? <CircleDot size={12} /> : <CheckCircle2 size={12} />} {closed ? 'Reopen' : 'Close'}
                </button>
                <span className="board-detail-spacer" />
                <button className="board-btn" onClick={onClose}>
                  Back
                </button>
              </>
            )}
          </div>

          {/* Comment thread + reply composer (read mode only). */}
          {!editing && (
            <div className="ticket-comments">
              <div className="board-detail-label">
                Comments{detail?.comments.length ? ` · ${detail.comments.length}` : ''}
              </div>
              {(detail?.comments.length ?? 0) === 0 && (
                <div className="board-detail-empty-body" style={{ fontSize: 12 }}>No comments yet.</div>
              )}
              {detail?.comments.map((c, i) => (
                <div className="ticket-comment" key={c.id || i}>
                  <div className="ticket-comment-head">
                    <span className="ticket-comment-author">{c.author}</span>
                    <span className="ticket-comment-time">{relativeTime(c.createdAt)}</span>
                    {c.viewerDidAuthor && c.id && editingCommentId !== c.id && (
                      <span className="ticket-comment-actions">
                        <button
                          className="ticket-comment-act"
                          title="Edit comment"
                          disabled={commentBusy}
                          onClick={() => {
                            setEditingCommentId(c.id)
                            setCommentDraft(c.body)
                          }}
                        >
                          <Pencil size={12} />
                        </button>
                        <button
                          className="ticket-comment-act danger"
                          title="Delete comment"
                          disabled={commentBusy}
                          onClick={() => void removeComment(c)}
                        >
                          <Trash2 size={12} />
                        </button>
                      </span>
                    )}
                  </div>
                  {editingCommentId === c.id ? (
                    <div className="ticket-comment-edit">
                      <textarea
                        className="board-detail-body"
                        rows={3}
                        value={commentDraft}
                        onChange={(e) => setCommentDraft(e.target.value)}
                        autoFocus
                      />
                      <div className="ticket-comment-edit-actions">
                        <button className="board-btn primary" disabled={commentBusy || !commentDraft.trim()} onClick={() => void saveCommentEdit(c)}>
                          {commentBusy ? 'Saving…' : 'Save'}
                        </button>
                        <button className="board-btn" disabled={commentBusy} onClick={() => setEditingCommentId(null)}>
                          Cancel
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div className="ticket-comment-body md">
                      <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]}>{c.body}</ReactMarkdown>
                    </div>
                  )}
                </div>
              ))}
              <div className="ticket-comment-composer">
                <textarea
                  className="board-detail-body"
                  rows={3}
                  value={comment}
                  onChange={(e) => setComment(e.target.value)}
                  placeholder="Write a comment…"
                />
                <button className="board-btn primary" disabled={commenting || !comment.trim()} onClick={() => void postComment()}>
                  {commenting ? 'Posting…' : 'Comment'}
                </button>
              </div>
            </div>
          )}

          {dispatchOpen && (
            <DispatchModal
              ticket={ticket}
              detail={detail}
              onClose={() => setDispatchOpen(false)}
              onDone={(msg) => {
                setDispatchOpen(false)
                setNote(msg)
                void onChanged()
              }}
            />
          )}

          {note && <div className="board-detail-note">{note}</div>}
        </div>
      )}
    </div>
  )
}

/** File a new GitHub issue onto a board from inside Artemis — pick the board, title, body,
 *  and an optional starting Status column. Gated write (the Create click is the gate). */
function CreateTicketView({
  projects,
  tickets,
  defaultBoard,
  onCreated,
  onDone
}: {
  projects: Project[]
  tickets: ProjectTicket[]
  defaultBoard: string
  onCreated: () => void | Promise<void>
  onDone: () => void
}): JSX.Element {
  // Every board across all projects → "project — Board" options (a project can have several).
  const boardOptions = useMemo(
    () =>
      projects.flatMap((p) =>
        p.boards.map((b) => ({
          key: `${p.name}#${b.number}`,
          project: p.name,
          number: b.number,
          title: b.title ?? '',
          label: `${p.name} — ${b.title || `#${b.number}`}`
        }))
      ),
    [projects]
  )
  const [selected, setSelected] = useState(
    boardOptions.find((o) => o.title.toLowerCase() === defaultBoard.toLowerCase())?.key || boardOptions[0]?.key || ''
  )
  const chosen = boardOptions.find((o) => o.key === selected)
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [status, setStatus] = useState('')
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | null>(null)

  // Status columns actually in use on the selected board (for the optional starting column).
  const statusOptions = useMemo(
    () => [...new Set(tickets.filter((t) => t.project === chosen?.project).map((t) => t.status).filter((s): s is string => !!s))],
    [tickets, chosen?.project]
  )

  const create = async (): Promise<void> => {
    if (!chosen || !title.trim()) return
    setBusy(true)
    setNote(null)
    try {
      const res = await window.artemis?.tickets?.create({
        project: chosen.project,
        boardNumber: chosen.number,
        title: title.trim(),
        body: body.trim() || undefined,
        status: status || undefined
      })
      if (res?.ok) {
        setNote(`✓ Created #${res.number}${res.statusSet ? ` in "${res.statusSet}"` : ''} on ${chosen.label}.`)
        setTitle('')
        setBody('')
        await onCreated()
      } else {
        setNote(`⚠ ${res?.error ?? 'Create failed.'}`)
      }
    } finally {
      setBusy(false)
    }
  }

  if (!boardOptions.length) {
    return <div className="board-empty">No project has a board mapped yet. Map one in Settings → Connections first.</div>
  }

  return (
    <div className="board-detail">
      <div className="board-detail-form">
        <label className="board-detail-label">Board</label>
        <select className="voice-select" value={selected} onChange={(e) => setSelected(e.target.value)} style={{ maxWidth: 320 }}>
          {boardOptions.map((o) => (
            <option key={o.key} value={o.key}>
              {o.label}
            </option>
          ))}
        </select>

        <label className="board-detail-label">Title</label>
        <input className="ollama-field board-title-input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Issue title" spellCheck={false} />

        <label className="board-detail-label">Status (optional)</label>
        <select className="voice-select" value={status} onChange={(e) => setStatus(e.target.value)} style={{ minWidth: 150 }}>
          <option value="">No status</option>
          {statusOptions.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>

        <label className="board-detail-label">Body (optional)</label>
        <textarea
          className="board-detail-body"
          value={body}
          onChange={(e) => setBody(e.target.value)}
          rows={8}
          placeholder="Describe the issue…"
        />

        <div className="board-detail-actions">
          <button className="board-btn primary" disabled={busy || !chosen || !title.trim()} onClick={() => void create()}>
            {busy ? 'Creating…' : 'Create ticket'}
          </button>
          <span className="board-detail-spacer" />
          <button className="board-btn" onClick={onDone}>
            Done
          </button>
        </div>
        {note && <div className="board-detail-note">{note}</div>}
      </div>
    </div>
  )
}

/** Focused modal for dispatching a worker at a ticket — collects instructions/context first
 *  (pre-filled with the ticket title + body) so a worker never fires without direction. */
function DispatchModal({
  ticket,
  detail,
  onDone,
  onClose
}: {
  ticket: ProjectTicket
  detail: TicketDetail | null
  onDone: (note: string) => void
  onClose: () => void
}): JSX.Element {
  const [task, setTask] = useState(() => [ticket.title, detail?.body?.trim()].filter(Boolean).join('\n\n'))
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const go = async (): Promise<void> => {
    if (!task.trim() || ticket.issueNumber == null) return
    setBusy(true)
    setErr(null)
    try {
      const res = await window.artemis?.tickets?.dispatch({
        project: ticket.project,
        ticketNumber: ticket.issueNumber,
        ticketRepo: ticket.repo,
        ticketUrl: ticket.url ?? undefined,
        boardId: ticket.boardId,
        task: task.trim()
      })
      if (res?.ok) onDone(`Worker dispatched — PR opened on ${res.branch}${res.note ?? ''}. It's in the review queue.`)
      else setErr(res?.error ?? 'unknown error')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="projects-overlay" style={{ zIndex: 90 }} onClick={onClose}>
      <div className="projects-panel dispatch-modal" onClick={(e) => e.stopPropagation()}>
        <div className="board-head">
          <span className="board-head-title">
            <Rocket size={15} /> Dispatch worker
            {ticket.issueNumber != null && <span className="board-head-count">#{ticket.issueNumber}</span>}
          </span>
          <div className="board-head-actions">
            <button onClick={onClose} title="Cancel">
              <X size={15} />
            </button>
          </div>
        </div>
        <div className="board-detail">
          <div className="board-detail-top">
            {ticket.repo && <span className="board-chip repo">{ticket.repo}</span>}
            <span className="board-detail-num">{ticket.title}</span>
          </div>
          <div className="board-detail-form">
            <label className="board-detail-label">Instructions &amp; context for the worker</label>
            <textarea
              className="board-detail-body"
              rows={9}
              value={task}
              onChange={(e) => setTask(e.target.value)}
              placeholder="Describe exactly what the worker should change, with any context it needs…"
              autoFocus
            />
            <div className="board-dispatch-note">
              The worker runs in an isolated worktree, makes the change, runs the repo&apos;s checks, and opens a PR that{' '}
              <code>Closes #{ticket.issueNumber}</code> — it never pushes to main. You approve it in the PR queue.
            </div>
            {err && <div className="board-detail-note" style={{ color: '#ff8a8a' }}>⚠ Could not dispatch: {err}</div>}
            <div className="board-detail-actions">
              <button className="board-dispatch-go" disabled={busy || !task.trim()} onClick={() => void go()}>
                {busy ? 'Dispatching…' : 'Dispatch worker'}
              </button>
              <button className="board-dispatch-cancel" disabled={busy} onClick={onClose}>
                Cancel
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
