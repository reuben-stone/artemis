import {
  useCallback,
  useEffect,
  useState,
  Fragment,
  type MouseEvent as ReactMouseEvent,
  type DragEvent as ReactDragEvent,
  type ReactNode
} from 'react'
import {
  ListTodo,
  CalendarDays,
  CalendarRange,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  Trash2,
  CornerUpRight,
  Sparkles,
  RefreshCw,
  SlidersHorizontal
} from 'lucide-react'
import { useOpsCards } from './OpsRail'
import { RailCard, type RailReorder } from './RailCard'
import type { Todo, CalendarEvent } from '../../../preload'

/**
 * The HUD left rail — an Artemis-managed cockpit living in the (mostly empty) orb pane.
 * It hosts four cards — PR Review + Ecosystem (the ops anchor) and Tickets + Calendar (the
 * personal day planner) — backed by the same SQLite/briefing data Artemis CRUDs via tools.
 * The user can resize it, collapse/hide/reorder each card, and the rail refetches whenever
 * a turn completes so agent-side edits show up live.
 */
function todayLabel(): string {
  return new Date().toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })
}

const PRIORITY_RANK: Record<string, number> = { high: 0, med: 1, low: 2 }

const RAIL_MIN = 200
const RAIL_MAX = 420
const RAIL_DEFAULT = 244

// The rail's cards, in default order — used by the show/hide menu and as the order seed.
const CARDS: Array<{ key: string; label: string }> = [
  { key: 'prs', label: 'PR Review' },
  { key: 'ecosystem', label: 'Ecosystem' },
  { key: 'tickets', label: 'Tickets' },
  { key: 'calendar', label: 'Calendar' }
]
const DEFAULT_ORDER = CARDS.map((c) => c.key)

function loadMap(key: string): Record<string, boolean> {
  try {
    return JSON.parse(localStorage.getItem(key) || '{}')
  } catch {
    return {}
  }
}

function loadOrder(): string[] {
  try {
    const saved = JSON.parse(localStorage.getItem('artemis.hud.cards.order') || 'null')
    if (Array.isArray(saved)) {
      // Keep saved order for known keys, append any new cards so it survives additions.
      const known = saved.filter((k: string) => DEFAULT_ORDER.includes(k))
      return [...known, ...DEFAULT_ORDER.filter((k) => !known.includes(k))]
    }
  } catch {
    /* fall through */
  }
  return DEFAULT_ORDER
}

export function HudRail({
  refreshSignal,
  onAsk,
  onOpenCalendar,
  onOpenPrs,
  onOpenBriefing
}: {
  refreshSignal: number
  onAsk: (prompt: string) => void
  onOpenCalendar: () => void
  onOpenPrs: () => void
  onOpenBriefing: () => void
}): JSX.Element {
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem('artemis.hud.collapsed') === '1')
  // User-adjustable rail width (drag the right edge). Clamped, persisted.
  const [width, setWidth] = useState(() => {
    const saved = Number(localStorage.getItem('artemis.hud.width'))
    return saved >= RAIL_MIN && saved <= RAIL_MAX ? saved : RAIL_DEFAULT
  })
  const [todos, setTodos] = useState<Todo[]>([])
  const [events, setEvents] = useState<CalendarEvent[]>([])
  const [draft, setDraft] = useState('')
  // Per-card collapse (fold) + hide (settings menu) + order (drag to reorder). Persisted.
  const [collapsedCards, setCollapsedCards] = useState<Record<string, boolean>>(() => loadMap('artemis.hud.cards.collapsed'))
  const [hiddenCards, setHiddenCards] = useState<Record<string, boolean>>(() => loadMap('artemis.hud.cards.hidden'))
  const [order, setOrder] = useState<string[]>(loadOrder)
  const [showCardMenu, setShowCardMenu] = useState(false)
  const [dragKey, setDragKey] = useState<string | null>(null)
  const [dragOverKey, setDragOverKey] = useState<string | null>(null)

  useEffect(() => {
    localStorage.setItem('artemis.hud.width', String(width))
  }, [width])
  useEffect(() => {
    localStorage.setItem('artemis.hud.cards.collapsed', JSON.stringify(collapsedCards))
  }, [collapsedCards])
  useEffect(() => {
    localStorage.setItem('artemis.hud.cards.hidden', JSON.stringify(hiddenCards))
  }, [hiddenCards])
  useEffect(() => {
    localStorage.setItem('artemis.hud.cards.order', JSON.stringify(order))
  }, [order])

  const toggleCollapse = useCallback((k: string) => setCollapsedCards((c) => ({ ...c, [k]: !c[k] })), [])
  const toggleHidden = useCallback((k: string) => setHiddenCards((h) => ({ ...h, [k]: !h[k] })), [])

  // Drag-to-reorder: a grip per card supplies these handlers; dropping a card on another
  // inserts it before that one. Plain (un-memoised) so it always sees the latest drag state.
  const reorderProps = (key: string): RailReorder => ({
    onDragStart: () => setDragKey(key),
    onDragEnd: () => {
      setDragKey(null)
      setDragOverKey(null)
    },
    onDragOver: (e: ReactDragEvent) => {
      e.preventDefault()
      if (dragOverKey !== key) setDragOverKey(key)
    },
    onDrop: () => {
      if (dragKey && dragKey !== key) {
        setOrder((cur) => {
          const next = cur.filter((k) => k !== dragKey)
          next.splice(next.indexOf(key), 0, dragKey)
          return next
        })
      }
      setDragKey(null)
      setDragOverKey(null)
    },
    dragging: dragKey === key,
    dragOver: dragOverKey === key && dragKey !== key
  })

  // The agent can expand the rail (show_panel 'rail') via a window event from App.
  useEffect(() => {
    const onHud = (e: Event): void => {
      if ((e as CustomEvent).detail === 'expand') {
        setCollapsed(false)
        localStorage.setItem('artemis.hud.collapsed', '0')
      }
    }
    window.addEventListener('artemis:hud', onHud)
    return () => window.removeEventListener('artemis:hud', onHud)
  }, [])

  const startResize = useCallback(
    (e: ReactMouseEvent) => {
      e.preventDefault()
      const startX = e.clientX
      const startW = width
      const onMove = (ev: MouseEvent) =>
        setWidth(Math.max(RAIL_MIN, Math.min(RAIL_MAX, startW + (ev.clientX - startX))))
      const onUp = () => {
        window.removeEventListener('mousemove', onMove)
        window.removeEventListener('mouseup', onUp)
        document.body.style.userSelect = ''
      }
      document.body.style.userSelect = 'none' // don't select text while dragging
      window.addEventListener('mousemove', onMove)
      window.addEventListener('mouseup', onUp)
    },
    [width]
  )

  const refresh = useCallback(async () => {
    const [t, e] = await Promise.all([window.artemis?.tasks?.list(), window.artemis?.calendar?.list()])
    if (t) setTodos(t)
    if (e) setEvents(e)
  }, [])

  // Initial load + whenever a turn finishes (Artemis may have changed the tables).
  useEffect(() => {
    void refresh()
  }, [refresh, refreshSignal])

  const toggle = useCallback(
    async (t: Todo) => {
      const next = t.status === 'done' ? 'todo' : 'done'
      setTodos((cur) => cur.map((x) => (x.id === t.id ? { ...x, status: next } : x)))
      await window.artemis?.tasks?.update(t.id, { status: next })
      void refresh()
    },
    [refresh]
  )

  const remove = useCallback(async (id: number) => {
    setTodos((cur) => cur.filter((x) => x.id !== id))
    await window.artemis?.tasks?.remove(id)
  }, [])

  const add = useCallback(async () => {
    const text = draft.trim()
    if (!text) return
    setDraft('')
    await window.artemis?.tasks?.add({ text })
    void refresh()
  }, [draft, refresh])

  const carryOver = useCallback(async () => {
    const updated = await window.artemis?.tasks?.carryOver()
    if (updated) setTodos(updated)
  }, [])

  const open = todos.filter((t) => t.status !== 'done')

  // Ops cards (PR Review + Ecosystem) come from a hook so they can share the one ordered
  // list with the day-planner cards below. (Hook — must run before the collapsed return.)
  const ops = useOpsCards({
    refreshSignal,
    onOpenPrs,
    onOpenBriefing,
    collapsed: collapsedCards,
    hidden: hiddenCards,
    onToggleCollapse: toggleCollapse,
    reorder: reorderProps
  })

  const ticketsNode = (
    <RailCard
      icon={<ListTodo size={13} />}
      title={`Tickets${open.length ? ` · ${open.length}` : ''}`}
      collapsed={!!collapsedCards.tickets}
      onToggleCollapse={() => toggleCollapse('tickets')}
      reorder={reorderProps('tickets')}
      actions={
        <button className="hud-mini" onClick={carryOver} title="Carry unfinished tasks from earlier days into today">
          <CornerUpRight size={13} />
        </button>
      }
    >
      <div className="hud-list">
        {todos.length === 0 && <div className="hud-empty">Nothing yet — add a ticket below.</div>}
        {[...todos]
          .sort((a, b) => {
            if ((a.status === 'done') !== (b.status === 'done')) return a.status === 'done' ? 1 : -1
            return (PRIORITY_RANK[a.priority ?? ''] ?? 3) - (PRIORITY_RANK[b.priority ?? ''] ?? 3)
          })
          .map((t) => (
            <div key={t.id} className={`hud-todo ${t.status === 'done' ? 'done' : ''} ${t.status === 'doing' ? 'doing' : ''}`}>
              <input
                type="checkbox"
                checked={t.status === 'done'}
                onChange={() => void toggle(t)}
                title={t.status === 'done' ? 'Reopen' : 'Mark done'}
              />
              {t.priority && <span className={`hud-prio p-${t.priority}`} title={`${t.priority} priority`} />}
              <span className="hud-todo-text">
                {t.text}
                {t.project && <span className="hud-chip">@{t.project}</span>}
                {t.source !== 'local' && <span className="hud-chip src">{t.source}</span>}
                {t.carriedFrom && t.carriedFrom !== t.day && (
                  <span className="hud-chip carry" title={`Carried from ${t.carriedFrom}`}>↻</span>
                )}
              </span>
              <button className="hud-todo-del" onClick={() => void remove(t.id)} title="Delete">
                <Trash2 size={12} />
              </button>
            </div>
          ))}
      </div>

      <div className="hud-add">
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void add()
          }}
          placeholder="Add a ticket…"
        />
        <button onClick={() => void add()} disabled={!draft.trim()} title="Add">
          <Plus size={14} />
        </button>
      </div>
    </RailCard>
  )

  const calendarNode = (
    <RailCard
      icon={<CalendarDays size={13} />}
      title="Today"
      collapsed={!!collapsedCards.calendar}
      onToggleCollapse={() => toggleCollapse('calendar')}
      reorder={reorderProps('calendar')}
      actions={
        <button className="hud-mini" onClick={onOpenCalendar} title="Open full calendar">
          <CalendarRange size={13} />
        </button>
      }
    >
      <div className="hud-list">
        {events.length === 0 && <div className="hud-empty">No events. Ask Artemis to schedule one.</div>}
        {events.map((e) => (
          <div key={e.id} className="hud-event">
            <span className="hud-event-when">{e.starts ? e.starts : 'all-day'}</span>
            <span className="hud-event-title">{e.title}</span>
          </div>
        ))}
      </div>
    </RailCard>
  )

  const cardNodes: Record<string, ReactNode> = {
    prs: ops.prs,
    ecosystem: ops.ecosystem,
    tickets: ticketsNode,
    calendar: calendarNode
  }

  if (collapsed) {
    return (
      <div className="hud-rail collapsed">
        <button
          className="hud-expand"
          onClick={() => {
            setCollapsed(false)
            localStorage.setItem('artemis.hud.collapsed', '0')
          }}
          title="Show HUD"
        >
          <PanelLeftOpen size={16} />
        </button>
        <div className="hud-rail-glyphs">
          <ListTodo size={16} />
          <CalendarDays size={16} />
        </div>
      </div>
    )
  }

  return (
    <div className="hud-rail" style={{ flexBasis: width, width }}>
      <div className="hud-rail-resize" onMouseDown={startResize} title="Drag to resize" />
      <div className="hud-rail-head">
        <span className="hud-rail-day">{todayLabel()}</span>
        <div className="hud-rail-head-actions">
          <button onClick={() => onAsk('Plan my day')} title="Ask Artemis to plan my day">
            <Sparkles size={14} />
          </button>
          <button onClick={() => void refresh()} title="Refresh">
            <RefreshCw size={14} />
          </button>
          <button
            className={showCardMenu ? 'on' : ''}
            onClick={() => setShowCardMenu((v) => !v)}
            title="Choose which cards show"
          >
            <SlidersHorizontal size={14} />
          </button>
          <button
            onClick={() => {
              setCollapsed(true)
              localStorage.setItem('artemis.hud.collapsed', '1')
            }}
            title="Collapse HUD"
          >
            <PanelLeftClose size={14} />
          </button>
        </div>
        {showCardMenu && (
          <div className="hud-cardmenu">
            <div className="hud-cardmenu-title">Show cards</div>
            {CARDS.map((c) => (
              <label key={c.key} className="hud-cardmenu-row">
                <input type="checkbox" checked={!hiddenCards[c.key]} onChange={() => toggleHidden(c.key)} />
                {c.label}
              </label>
            ))}
          </div>
        )}
      </div>

      <div className="hud-rail-body">
        {order.filter((k) => !hiddenCards[k]).map((k) => <Fragment key={k}>{cardNodes[k]}</Fragment>)}
      </div>
    </div>
  )
}
