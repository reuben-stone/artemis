/**
 * GitHub Projects (v2) connector — the ingest + write half of the ticket operator loop
 * (ROADMAP-TO-JARVIS.md → "The north star"). The dispatch/PR back half already lives in
 * worker.ts; this is what feeds it.
 *
 * Reads a cross-repo Projects v2 board (status columns, assignees, labels) into the local
 * cache (store.ts `project_tickets`) and performs only narrow, explicit writes: create an
 * issue, add it to the board, set its status column. GitHub stays the source of truth — a
 * sync is a full-replace per board, never a two-way mirror.
 *
 * Auth rides the existing `gh` CLI (no stored PAT): `gh api graphql` for board reads,
 * `gh issue create` / `gh project item-add|item-edit|field-list` for writes. Projects v2
 * needs the `project` scope on the gh token — `gh auth refresh -s project`.
 *
 * The pure helpers (buildBoardQuery / mapBoardResponse / formatTicketBranch /
 * formatClosesLine) are dependency-free so the smoke harness can import them, exactly like
 * parseGitRemote in github.ts.
 *
 * PROVIDER SEAM: this module is the GitHub **reference** connector. The cache (project_tickets),
 * agent tools, and UI deliberately speak provider-neutral nouns (board/ticket/status/comment),
 * and every board carries a `provider` tag (BoardConfig.provider, default 'github'). A future
 * Jira / Azure DevOps connector would be a sibling module selected by that tag — see
 * ROADMAP-TO-JARVIS.md ("Multi-provider board connectors"). We intentionally have NOT frozen a
 * `BoardProvider` interface yet: the right shape only becomes clear with the second
 * implementation (Jira transitions vs Azure states vs GitHub field-options don't share an
 * obvious signature), so abstracting now would likely be the wrong abstraction.
 */
import { exec } from 'child_process'
import { promisify } from 'util'
import { parseGitRemote } from './github'
import {
  getProjectBoards,
  updateProjectBoard,
  replaceTicketsForProject,
  type TicketUpsert,
  listPrReviews,
  updatePrOutcome,
  setGithubViewer,
  type BoardConfig
} from './store'

const execp = promisify(exec)

// ---------------------------------------------------------------------------
// Pure helpers (dependency-free; unit-tested in the smoke harness)
// ---------------------------------------------------------------------------

export interface MappedComment {
  author: string
  body: string
  at: number // ms
}

/** A board item flattened to the shape store.upsertTicket expects (sans `project`). */
export interface MappedTicket {
  repo: string | null
  itemId: string
  issueNumber: number | null
  contentId: string | null
  title: string
  status: string | null
  assignees: string | null
  labels: string | null
  url: string | null
  updatedAt: number | null
  comments: MappedComment[]
}

/**
 * The GraphQL query string for reading a Projects v2 board's items. `owner`, `number`, and
 * `after` are passed as runtime variables (injection-safe via `gh api graphql -F/-f`); only
 * the root field differs by owner kind, so that's the one thing baked into the string.
 * Status is read name-addressably (`fieldValueByName(name:"Status")`) — no field-id lookup
 * needed for reads.
 */
export function buildBoardQuery(ownerType: 'org' | 'user'): string {
  const root = ownerType === 'org' ? 'organization' : 'user'
  // `viewer` (your login) lets us exclude your own comments from "new"; comments(last:5) rides
  // the same query so the notifications feed needs no extra per-issue calls.
  return `query($owner: String!, $number: Int!, $after: String) {
  viewer { login }
  ${root}(login: $owner) {
    projectV2(number: $number) {
      id
      title
      items(first: 50, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id
          updatedAt
          fieldValueByName(name: "Status") {
            ... on ProjectV2ItemFieldSingleSelectValue { name }
          }
          content {
            __typename
            ... on Issue {
              id number title url
              repository { nameWithOwner }
              assignees(first: 10) { nodes { login } }
              labels(first: 10) { nodes { name } }
              comments(last: 5) { nodes { author { login } body createdAt } }
            }
            ... on PullRequest {
              id number title url
              repository { nameWithOwner }
              comments(last: 5) { nodes { author { login } body createdAt } }
            }
            ... on DraftIssue { title }
          }
        }
      }
    }
  }
}`
}

interface BoardPage {
  boardId: string | null
  title: string | null
  viewerLogin: string | null
  tickets: MappedTicket[]
  pageInfo: { hasNextPage: boolean; endCursor: string | null }
}

/**
 * Flatten one page of a board-query response into MappedTickets. Tolerates either root
 * field (organization|user). Draft issues (no number/url — not dispatchable or linkable)
 * are skipped from the actionable board.
 */
export function mapBoardResponse(json: unknown): BoardPage {
  const data = (json as { data?: Record<string, unknown> })?.data ?? {}
  const proj =
    ((data.organization as { projectV2?: Record<string, unknown> })?.projectV2 ??
      (data.user as { projectV2?: Record<string, unknown> })?.projectV2 ??
      null) as Record<string, unknown> | null
  const items = proj?.items as { nodes?: unknown[]; pageInfo?: Record<string, unknown> } | undefined
  const nodes = (items?.nodes ?? []) as Array<Record<string, unknown>>
  const tickets: MappedTicket[] = []
  for (const node of nodes) {
    const content = node?.content as Record<string, unknown> | null
    if (!content) continue
    if (content.__typename === 'DraftIssue') continue
    const repo = (content.repository as { nameWithOwner?: string })?.nameWithOwner ?? null
    const assignees = (((content.assignees as { nodes?: Array<{ login?: string }> })?.nodes ?? [])
      .map((a) => a.login)
      .filter(Boolean) as string[]).join(', ')
    const labels = (((content.labels as { nodes?: Array<{ name?: string }> })?.nodes ?? [])
      .map((l) => l.name)
      .filter(Boolean) as string[]).join(', ')
    const updatedRaw = node.updatedAt as string | undefined
    const comments = (((content.comments as { nodes?: Array<{ author?: { login?: string }; body?: string; createdAt?: string }> })?.nodes ?? [])
      .map((c) => ({ author: c.author?.login ?? 'unknown', body: c.body ?? '', at: c.createdAt ? Date.parse(c.createdAt) : 0 }))
      .filter((c) => c.at > 0)) as MappedComment[]
    tickets.push({
      repo,
      itemId: node.id as string,
      issueNumber: typeof content.number === 'number' ? (content.number as number) : null,
      contentId: (content.id as string) ?? null,
      title: (content.title as string) ?? '(untitled)',
      status: ((node.fieldValueByName as { name?: string })?.name as string) ?? null,
      assignees: assignees || null,
      labels: labels || null,
      url: (content.url as string) ?? null,
      updatedAt: updatedRaw ? Date.parse(updatedRaw) : null,
      comments
    })
  }
  const pi = (items?.pageInfo ?? {}) as { hasNextPage?: boolean; endCursor?: string }
  return {
    boardId: (proj?.id as string) ?? null,
    title: (proj?.title as string) ?? null,
    viewerLogin: ((data.viewer as { login?: string })?.login as string) ?? null,
    tickets,
    pageInfo: { hasNextPage: !!pi.hasNextPage, endCursor: pi.endCursor ?? null }
  }
}

/** The branch a worker uses when dispatched from a ticket — the stable, linkable identity. */
export function formatTicketBranch(n: number): string {
  return `artemis/ticket-${n}`
}

/** The PR-body line that makes GitHub natively wire the PR to the ticket (and the board).
 *  Pass the issue's repo slug for a CROSS-repo close (the issue lives in a different repo than
 *  the PR — common when a board aggregates issues from several repos). */
export function formatClosesLine(n: number, repo?: string | null): string {
  return repo ? `Closes ${repo}#${n}` : `Closes #${n}`
}

export interface PrOutcome {
  state: string // open | merged | closed
  checks: string // success | failure | pending | none
  reviewDecision: string // approved | changes_requested | review_required | none
}

/** Collapse a `statusCheckRollup` array into one CI verdict. Any failure wins; else any
 *  in-flight check → pending; else success; empty → none. Handles both CheckRun
 *  (status/conclusion) and legacy StatusContext (state) shapes. */
function rollupChecks(rollup: Array<Record<string, unknown>>): string {
  if (!rollup.length) return 'none'
  let pending = false
  for (const c of rollup) {
    const status = String(c.status ?? '').toUpperCase()
    const conclusion = String(c.conclusion ?? '').toUpperCase()
    const ctxState = String(c.state ?? '').toUpperCase()
    if (
      ['FAILURE', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STARTUP_FAILURE'].includes(conclusion) ||
      ['FAILURE', 'ERROR'].includes(ctxState)
    ) {
      return 'failure'
    }
    if ((status && status !== 'COMPLETED') || ctxState === 'PENDING') pending = true
  }
  return pending ? 'pending' : 'success'
}

/** Map a `gh pr view --json …` payload to a compact outcome. Pure — unit-tested. */
export function mapPrOutcome(json: unknown): PrOutcome {
  const o = (json ?? {}) as { state?: string; reviewDecision?: string; statusCheckRollup?: Array<Record<string, unknown>> }
  return {
    state: (o.state ?? '').toLowerCase() || 'open',
    checks: rollupChecks(o.statusCheckRollup ?? []),
    reviewDecision: (o.reviewDecision ?? '').toLowerCase() || 'none'
  }
}

/** Pull one PR's live outcome (merge state, CI, review decision) from GitHub via gh. */
export async function fetchPrOutcome(url: string): Promise<PrOutcome> {
  const { stdout } = await execp(
    `gh pr view ${shellQuote(url)} --json state,mergedAt,closedAt,statusCheckRollup,reviewDecision`,
    { maxBuffer: 4 * 1024 * 1024 }
  )
  return mapPrOutcome(JSON.parse(stdout))
}

/** Refresh the outcome of every not-yet-reviewed PR in the queue. Returns how many synced.
 *  Best-effort: a deleted/inaccessible PR keeps its last-known outcome and is skipped. */
export async function syncPrOutcomes(): Promise<number> {
  let synced = 0
  for (const p of listPrReviews().filter((p) => !p.reviewed)) {
    try {
      updatePrOutcome(p.id, await fetchPrOutcome(p.url))
      synced++
    } catch {
      /* skip */
    }
  }
  return synced
}

// ---------------------------------------------------------------------------
// Effectful (gh CLI) — read + write paths
// ---------------------------------------------------------------------------

/** Single-quote a value for the shell (mirrors worker.ts). */
function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`
}

/** Run a GraphQL query via `gh api graphql`, passing typed variables. Throws on gh or
 *  GraphQL errors, sliced to keep the message compact (like ga.ts). */
async function ghGraphql(query: string, vars: Record<string, string | number>): Promise<unknown> {
  const parts = [`gh api graphql -f query=${shellQuote(query)}`]
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined || v === null || v === '') continue
    const flag = typeof v === 'number' ? '-F' : '-f' // -F = typed (Int), -f = raw string
    parts.push(`${flag} ${k}=${shellQuote(String(v))}`)
  }
  let stdout: string
  try {
    ;({ stdout } = await execp(parts.join(' '), { maxBuffer: 8 * 1024 * 1024 }))
  } catch (e: unknown) {
    const err = e as { stderr?: string; message?: string }
    throw new Error(`gh graphql failed: ${(err.stderr || err.message || String(e)).slice(0, 200)}`)
  }
  const json = JSON.parse(stdout) as { errors?: unknown[] }
  if (json.errors?.length) throw new Error(`GraphQL error: ${JSON.stringify(json.errors).slice(0, 200)}`)
  return json
}

export interface OwnerBoard {
  number: number
  title: string
  closed: boolean
}

/**
 * List the Projects v2 boards an owner has — for the no-guesswork picker. `repositoryOwner`
 * resolves to either an Organization or a User, and `__typename` tells us which (so the UI
 * doesn't have to ask org-vs-user). Returns the owner kind + the boards.
 */
export async function listOwnerBoards(owner: string): Promise<{ ownerType: 'org' | 'user'; boards: OwnerBoard[] }> {
  const query = `query($owner: String!) {
  repositoryOwner(login: $owner) {
    __typename
    ... on Organization { projectsV2(first: 50) { nodes { number title closed } } }
    ... on User { projectsV2(first: 50) { nodes { number title closed } } }
  }
}`
  const json = (await ghGraphql(query, { owner })) as {
    data?: { repositoryOwner?: { __typename?: string; projectsV2?: { nodes?: Array<{ number: number; title: string; closed: boolean }> } } }
  }
  const ro = json?.data?.repositoryOwner
  if (!ro) throw new Error(`No GitHub org or user named "${owner}".`)
  const ownerType = ro.__typename === 'Organization' ? 'org' : 'user'
  const boards = (ro.projectsV2?.nodes ?? []).filter(Boolean).map((n) => ({ number: n.number, title: n.title, closed: !!n.closed }))
  return { ownerType, boards }
}

/** Fetch a whole board (paginated, bounded): id/title, the viewer's login, and all tickets. */
export async function fetchBoard(
  cfg: BoardConfig
): Promise<{ boardId: string; title: string; viewerLogin: string; tickets: MappedTicket[] }> {
  const query = buildBoardQuery(cfg.ownerType)
  let after: string | null = null
  let boardId = cfg.boardId ?? ''
  let title = cfg.title ?? ''
  let viewerLogin = ''
  const tickets: MappedTicket[] = []
  for (let page = 0; page < 10; page++) {
    const vars: Record<string, string | number> = { owner: cfg.owner, number: cfg.number }
    if (after) vars.after = after
    const mapped = mapBoardResponse(await ghGraphql(query, vars))
    if (!mapped.boardId && page === 0) {
      throw new Error(
        'Board not found — check owner / type / number, and that the gh token has the `project` scope (gh auth refresh -s project).'
      )
    }
    boardId = mapped.boardId ?? boardId
    title = mapped.title ?? title
    viewerLogin = mapped.viewerLogin ?? viewerLogin
    tickets.push(...mapped.tickets)
    if (!mapped.pageInfo.hasNextPage || !mapped.pageInfo.endCursor) break
    after = mapped.pageInfo.endCursor
  }
  return { boardId, title, viewerLogin, tickets }
}

/** Read ALL boards mapped to a project and replace its cached tickets (one pass per board,
 *  accumulated then replaced once so multiple boards don't wipe each other). Returns the count. */
export async function syncBoardForProject(projectName: string, projectPath: string): Promise<number> {
  const boards = getProjectBoards(projectPath)
  if (!boards.length) throw new Error(`No GitHub Projects board configured for "${projectName}".`)
  const rows: Array<Omit<TicketUpsert, 'project'>> = []
  for (const cfg of boards) {
    const board = await fetchBoard(cfg)
    // Cache the discovered board id/title back onto this board entry — writes need the id.
    let merged = cfg
    if (board.boardId && (board.boardId !== cfg.boardId || board.title !== cfg.title)) {
      merged = { ...cfg, boardId: board.boardId, title: board.title }
      updateProjectBoard(projectPath, merged)
    }
    // Capture the board's FULL Status column list (incl. empty columns) so the kanban can render
    // every column as a drop target, not just the ones that currently hold tickets. Caches onto
    // the board config; non-fatal if the board has no Status field or the scope is missing.
    try {
      await ensureStatusField(merged, projectPath)
    } catch {
      /* read sync shouldn't fail just because we couldn't read the column list */
    }
    // Remember who we are on GitHub so our own comments aren't flagged as "new" notifications.
    if (board.viewerLogin) setGithubViewer(board.viewerLogin)
    for (const t of board.tickets) {
      rows.push({
        repo: t.repo,
        boardId: board.boardId,
        boardTitle: board.title || null,
        itemId: t.itemId,
        issueNumber: t.issueNumber,
        contentId: t.contentId,
        title: t.title,
        status: t.status,
        assignees: t.assignees,
        labels: t.labels,
        url: t.url,
        updatedAt: t.updatedAt,
        comments: t.comments.length ? JSON.stringify(t.comments) : null,
        lastCommentAt: t.comments.length ? Math.max(...t.comments.map((c) => c.at)) : null
      })
    }
  }
  replaceTicketsForProject(projectName, rows)
  return rows.length
}

/** Discover (and cache) the board node id + Status field id/options via `gh project`. */
async function ensureStatusField(
  cfg: BoardConfig,
  projectPath: string
): Promise<{ boardId: string; fieldId: string; options: Array<{ id: string; name: string }> }> {
  let { boardId, statusFieldId, statusOptions } = cfg
  if (!boardId) {
    const { stdout } = await execp(
      `gh project view ${cfg.number} --owner ${shellQuote(cfg.owner)} --format json`,
      { maxBuffer: 4 * 1024 * 1024 }
    )
    boardId = (JSON.parse(stdout) as { id: string }).id
  }
  if (!statusFieldId || !statusOptions) {
    const { stdout } = await execp(
      `gh project field-list ${cfg.number} --owner ${shellQuote(cfg.owner)} --format json`,
      { maxBuffer: 4 * 1024 * 1024 }
    )
    const fields = (JSON.parse(stdout) as { fields: Array<{ id: string; name: string; options?: Array<{ id: string; name: string }> }> }).fields
    const status = fields.find((f) => f.name.toLowerCase() === 'status' && f.options)
    if (!status?.options) throw new Error('No single-select "Status" field on this board.')
    statusFieldId = status.id
    statusOptions = status.options.map((o) => ({ id: o.id, name: o.name }))
  }
  updateProjectBoard(projectPath, { ...cfg, boardId, statusFieldId, statusOptions })
  return { boardId, fieldId: statusFieldId, options: statusOptions }
}

export interface CreatedTicket {
  url: string
  number: number
  onBoard: boolean // was it added to a Projects board? (false when the project has no board mapped)
  statusSet: string | null // the status column actually applied, or null
}

/**
 * Create a GitHub issue, add it to the project's board, and (optionally) set its status
 * column. Outward-effecting — gated upstream like dispatch_worker. Reports honestly whether
 * it actually reached the board (it can't, if the project has no board mapped), and refreshes
 * the local cache so the new ticket shows up immediately.
 */
export async function createTicket(opts: {
  projectName: string
  projectPath: string
  remote: string | null
  board?: BoardConfig | null // which board to add it to (a project can have several); null = none
  title: string
  body?: string
  status?: string
}): Promise<CreatedTicket> {
  const gh = parseGitRemote(opts.remote)
  if (!gh) throw new Error('Project has no GitHub remote — cannot create an issue.')
  // 1. create the issue (lives in the project's repo — shared monorepo code included)
  const { stdout } = await execp(
    `gh issue create --repo ${gh.slug} --title ${shellQuote(opts.title)} --body ${shellQuote(opts.body ?? '')}`,
    { maxBuffer: 4 * 1024 * 1024 }
  )
  const url = stdout.trim().split('\n').find((l) => l.startsWith('http')) ?? stdout.trim()
  const number = Number(url.split('/').pop())

  // 2. add it to the chosen board (a project can map to several). Without one, the issue
  //    exists but isn't on any board (and no status).
  const cfg = opts.board ?? null
  let onBoard = false
  let statusSet: string | null = null
  if (cfg) {
    try {
      const { stdout: addOut } = await execp(
        `gh project item-add ${cfg.number} --owner ${shellQuote(cfg.owner)} --url ${shellQuote(url)} --format json`,
        { maxBuffer: 4 * 1024 * 1024 }
      )
      const itemId = (JSON.parse(addOut) as { id: string }).id
      onBoard = !!itemId
      // 3. set the status column, if asked
      if (opts.status && itemId) {
        const { boardId, fieldId, options } = await ensureStatusField(cfg, opts.projectPath)
        const opt = options.find((o) => o.name.toLowerCase() === opts.status!.toLowerCase())
        if (opt) {
          await execp(
            `gh project item-edit --id ${shellQuote(itemId)} --project-id ${shellQuote(boardId)} --field-id ${shellQuote(fieldId)} --single-select-option-id ${shellQuote(opt.id)}`,
            { maxBuffer: 4 * 1024 * 1024 }
          )
          statusSet = opt.name
        }
      }
    } catch (e: unknown) {
      throw new Error(
        `Issue created (${url}) but updating the board failed: ${(e instanceof Error ? e.message : String(e)).slice(0, 160)}`
      )
    }
    // 4. refresh the cache so the new ticket appears on the board straight away (no manual sync).
    await syncBoardForProject(opts.projectName, opts.projectPath).catch(() => {})
  }
  return { url, number, onBoard, statusSet }
}

export interface TicketComment {
  id: string // GitHub GraphQL node id — needed to edit/delete the comment
  author: string
  body: string
  createdAt: string
  viewerDidAuthor: boolean // whether the signed-in gh user wrote it (gates edit/delete in the UI)
}

export interface TicketDetail {
  number: number
  title: string
  body: string
  state: string // open | closed
  url: string
  labels: string[]
  assignees: string[]
  comments: TicketComment[]
}

/** Full detail for one ticket (body + comments, which the board cache doesn't hold) — for the
 *  in-app detail view. */
export async function getTicketDetail(slug: string, number: number): Promise<TicketDetail> {
  const { stdout } = await execp(
    `gh issue view ${number} --repo ${shellQuote(slug)} --json number,title,body,state,url,labels,assignees,comments`,
    { maxBuffer: 8 * 1024 * 1024 }
  )
  const j = JSON.parse(stdout) as {
    number: number
    title: string
    body?: string
    state?: string
    url: string
    labels?: Array<{ name: string }>
    assignees?: Array<{ login: string }>
    comments?: Array<{ id?: string; author?: { login?: string }; body?: string; createdAt?: string; viewerDidAuthor?: boolean }>
  }
  return {
    number: j.number,
    title: j.title,
    body: j.body ?? '',
    state: String(j.state ?? '').toLowerCase(),
    url: j.url,
    labels: (j.labels ?? []).map((l) => l.name),
    assignees: (j.assignees ?? []).map((a) => a.login),
    comments: (j.comments ?? []).map((c) => ({
      id: c.id ?? '',
      author: c.author?.login ?? 'unknown',
      body: c.body ?? '',
      createdAt: c.createdAt ?? '',
      viewerDidAuthor: !!c.viewerDidAuthor
    }))
  }
}

/** Post a comment on a ticket (outward write — gated upstream). Returns the refreshed detail. */
export async function addTicketComment(slug: string, number: number, body: string): Promise<TicketDetail> {
  await execp(`gh issue comment ${number} --repo ${shellQuote(slug)} --body ${shellQuote(body)}`, {
    maxBuffer: 4 * 1024 * 1024
  })
  return getTicketDetail(slug, number)
}

/** Edit one of your own comments (by its GraphQL node id) — outward write, gated upstream.
 *  Returns the refreshed detail so the thread updates in place. */
export async function editTicketComment(slug: string, number: number, commentId: string, body: string): Promise<TicketDetail> {
  await ghGraphql('mutation($id:ID!,$body:String!){updateIssueComment(input:{id:$id,body:$body}){clientMutationId}}', {
    id: commentId,
    body
  })
  return getTicketDetail(slug, number)
}

/** Delete one of your own comments (by its GraphQL node id) — outward write, gated upstream.
 *  Returns the refreshed detail (the comment now gone). */
export async function deleteTicketComment(slug: string, number: number, commentId: string): Promise<TicketDetail> {
  await ghGraphql('mutation($id:ID!){deleteIssueComment(input:{id:$id}){clientMutationId}}', { id: commentId })
  return getTicketDetail(slug, number)
}

/**
 * Apply edits to a ticket from inside Artemis: title/body, open/closed state, and/or its
 * board Status column. Each is a narrow, explicit gh write; the board cache is refreshed
 * after so the change shows immediately. Outward-effecting — gated upstream.
 */
export async function updateTicket(opts: {
  projectName: string
  projectPath: string
  repo: string | null // the ISSUE's repo slug (owner/repo) — where it actually lives, not the project's
  board?: BoardConfig | null // the board this ticket is on (for the Status mutation)
  number: number
  itemId?: string | null
  patch: { title?: string; body?: string; state?: 'open' | 'closed'; status?: string }
}): Promise<void> {
  // Issue edits/state target the repo the issue LIVES in (a board can hold issues from a repo
  // that isn't the project's own) — never the project's remote.
  const slug = opts.repo
  const { number, patch } = opts

  if (patch.title != null || patch.body != null || patch.state) {
    if (!slug) throw new Error('No repo for this ticket — cannot edit the issue.')
  }
  if (patch.title != null || patch.body != null) {
    const parts = [`gh issue edit ${number} --repo ${shellQuote(slug!)}`]
    if (patch.title != null) parts.push(`--title ${shellQuote(patch.title)}`)
    if (patch.body != null) parts.push(`--body ${shellQuote(patch.body)}`)
    await execp(parts.join(' '), { maxBuffer: 4 * 1024 * 1024 })
  }
  if (patch.state === 'closed') await execp(`gh issue close ${number} --repo ${shellQuote(slug!)}`)
  if (patch.state === 'open') await execp(`gh issue reopen ${number} --repo ${shellQuote(slug!)}`)

  // Move the board Status column — needs the item id (from the cached ticket) + the ticket's board.
  if (patch.status && opts.itemId) {
    const cfg = opts.board
    if (cfg) {
      const { boardId, fieldId, options } = await ensureStatusField(cfg, opts.projectPath)
      const opt = options.find((o) => o.name.toLowerCase() === patch.status!.toLowerCase())
      if (opt) {
        await execp(
          `gh project item-edit --id ${shellQuote(opts.itemId)} --project-id ${shellQuote(boardId)} --field-id ${shellQuote(fieldId)} --single-select-option-id ${shellQuote(opt.id)}`,
          { maxBuffer: 4 * 1024 * 1024 }
        )
      }
    }
  }
  await syncBoardForProject(opts.projectName, opts.projectPath).catch(() => {})
}
