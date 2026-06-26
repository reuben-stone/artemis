import { useCallback, useEffect, useMemo, useState } from 'react'
import { X, ListTodo, ChevronLeft, ChevronRight, Plus, Trash2, Circle, CircleDot, CheckCircle2, CornerDownRight } from 'lucide-react'
import type { Todo, TodoStatus } from '../../../preload'

/**
 * The full Tasks surface — a roomy day-planner modal opened from the HUD rail (or by Artemis
 * via show_panel 'tasks'). Reads/writes the SAME local todos table Artemis CRUDs through its
 * tools, so the two never diverge; onChanged refreshes the rail. Beyond the rail card it adds:
 * day navigation, status grouping, edit text / priority / project, move-day, and visible
 * carry-over (unfinished tasks parked on earlier days), so slippage stays in view.
 */
const STATUS_ORDER: TodoStatus[] = ['todo', 'doing', 'done']
const STATUS_LABEL: Record<TodoStatus, string> = { todo: 'To do', doing: 'Doing', done: 'Done' }
const NEXT_STATUS: Record<TodoStatus, TodoStatus> = { todo: 'doing', doing: 'done', done: 'todo' }
const PRIORITIES = ['', 'low', 'med', 'high']

function ymd(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
function parseYmd(s: string): Date {
  return new Date(`${s}T12:00:00`) // noon anchor — never trips DST
}
function dayLabel(s: string, today: string): string {
  if (s === today) return 'Today'
  const anchor = parseYmd(today).getTime()
  if (s === ymd(new Date(anchor - 86400000))) return 'Yesterday'
  if (s === ymd(new Date(anchor + 86400000))) return 'Tomorrow'
  return parseYmd(s).toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' })
}

function StatusIcon({ status }: { status: TodoStatus }): JSX.Element {
  if (status === 'done') return <CheckCircle2 size={15} />
  if (status === 'doing') return <CircleDot size={15} />
  return <Circle size={15} />
}

export function TasksView({
  initialDay,
  refreshSignal,
  onChanged,
  onClose
}: {
  initialDay?: string | null
  refreshSignal?: number // bumps when a turn settles → refetch so agent edits show live
  onChanged: () => void
  onClose: () => void
}): JSX.Element {
  const today = ymd(new Date())
  const [day, setDay] = useState(initialDay || today)
  const [todos, setTodos] = useState<Todo[]>([])
  const [carry, setCarry] = useState<Todo[]>([]) // unfinished from earlier days
  const [editId, setEditId] = useState<number | null>(null)
  const [editText, setEditText] = useState('')
  // Add form
  const [draft, setDraft] = useState('')
  const [draftPriority, setDraftPriority] = useState('')
  const [draftProject, setDraftProject] = useState('')

  const load = useCallback(async () => {
    const [list, before] = await Promise.all([
      window.artemis?.tasks?.list(day),
      window.artemis?.tasks?.listBefore?.(day)
    ])
    if (list) setTodos(list)
    setCarry(before ?? [])
  }, [day])

  useEffect(() => {
    void load()
  }, [load])
  // Live refresh: when a turn settles, re-pull so tasks Artemis just added/moved/removed show
  // in an already-open modal — the "act-then-show" loop. (Local edit/draft state is untouched.)
  useEffect(() => {
    if (refreshSignal !== undefined) void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshSignal])

  const shiftDay = (delta: number): void => setDay((d) => ymd(new Date(parseYmd(d).getTime() + delta * 86400000)))

  const refresh = useCallback(async () => {
    await load()
    onChanged()
  }, [load, onChanged])

  const add = useCallback(async () => {
    const text = draft.trim()
    if (!text) return
    await window.artemis?.tasks?.add({
      day,
      text,
      priority: draftPriority || undefined,
      project: draftProject.trim() || undefined
    })
    setDraft('')
    setDraftPriority('')
    setDraftProject('')
    await refresh()
  }, [draft, draftPriority, draftProject, day, refresh])

  const cycleStatus = async (t: Todo): Promise<void> => {
    await window.artemis?.tasks?.update(t.id, { status: NEXT_STATUS[t.status] })
    await refresh()
  }
  const remove = async (id: number): Promise<void> => {
    await window.artemis?.tasks?.remove(id)
    await refresh()
  }
  const saveEdit = async (t: Todo): Promise<void> => {
    const text = editText.trim()
    setEditId(null)
    if (text && text !== t.text) {
      await window.artemis?.tasks?.update(t.id, { text })
      await refresh()
    }
  }
  const moveToDay = async (t: Todo, target: string): Promise<void> => {
    await window.artemis?.tasks?.update(t.id, { day: target })
    await refresh()
  }
  const carryAll = async (): Promise<void> => {
    await window.artemis?.tasks?.carryOver(today)
    setDay(today)
    await refresh()
  }

  const grouped = useMemo(() => {
    const m: Record<TodoStatus, Todo[]> = { todo: [], doing: [], done: [] }
    for (const t of todos) m[t.status].push(t)
    return m
  }, [todos])

  const openCount = grouped.todo.length + grouped.doing.length

  const taskRow = (t: Todo): JSX.Element => (
    <div className={`tk-row ${t.status}`} key={t.id}>
      <button className="tk-status" onClick={() => void cycleStatus(t)} title={`Mark ${NEXT_STATUS[t.status]}`}>
        <StatusIcon status={t.status} />
      </button>
      {editId === t.id ? (
        <input
          className="tk-edit"
          value={editText}
          autoFocus
          onChange={(e) => setEditText(e.target.value)}
          onBlur={() => void saveEdit(t)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void saveEdit(t)
            if (e.key === 'Escape') setEditId(null)
          }}
        />
      ) : (
        <button
          className="tk-text"
          onClick={() => {
            setEditId(t.id)
            setEditText(t.text)
          }}
          title="Click to edit"
        >
          {t.text}
        </button>
      )}
      {t.priority && <span className={`tk-chip pri ${t.priority}`}>{t.priority}</span>}
      {t.project && <span className="tk-chip proj">{t.project}</span>}
      {t.carriedFrom && t.carriedFrom !== t.day && <span className="tk-chip carry">carried</span>}
      <span className="tk-spacer" />
      {day !== today && (
        <button className="tk-act" onClick={() => void moveToDay(t, today)} title="Move to today">
          <CornerDownRight size={13} />
        </button>
      )}
      <button className="tk-act danger" onClick={() => void remove(t.id)} title="Delete task">
        <Trash2 size={13} />
      </button>
    </div>
  )

  return (
    <div className="projects-overlay" onClick={onClose}>
      <div className="projects-panel tasks-modal" onClick={(e) => e.stopPropagation()}>
        <div className="projects-head">
          <span>
            <ListTodo size={14} /> TASKS
          </span>
          <div className="tk-daynav">
            <button onClick={() => shiftDay(-1)} title="Previous day">
              <ChevronLeft size={16} />
            </button>
            <button className={`tk-daylabel ${day === today ? 'today' : ''}`} onClick={() => setDay(today)} title="Jump to today">
              {dayLabel(day, today)}
            </button>
            <button onClick={() => shiftDay(1)} title="Next day">
              <ChevronRight size={16} />
            </button>
          </div>
          <button className="projects-close" onClick={onClose} title="Close">
            <X size={14} />
          </button>
        </div>

        <div className="tk-body">
          {/* Carry-over: unfinished tasks still parked on earlier days. */}
          {day === today && carry.length > 0 && (
            <div className="tk-carry">
              <div className="tk-carry-head">
                <span>{carry.length} unfinished from earlier</span>
                <button className="tk-carry-btn" onClick={() => void carryAll()} title="Roll all unfinished tasks onto today">
                  <CornerDownRight size={12} /> Carry all to today
                </button>
              </div>
              {carry.slice(0, 6).map((t) => (
                <div className="tk-carry-row" key={t.id}>
                  <span className="tk-carry-day">{dayLabel(t.day, today)}</span>
                  <span className="tk-carry-text">{t.text}</span>
                  <button className="tk-act" onClick={() => void moveToDay(t, today)} title="Move this one to today">
                    <CornerDownRight size={12} />
                  </button>
                </div>
              ))}
              {carry.length > 6 && <div className="tk-carry-more">+{carry.length - 6} more</div>}
            </div>
          )}

          {/* The day's tasks, grouped by status. */}
          <div className="tk-groups">
            {todos.length === 0 ? (
              <div className="tk-empty">Nothing for {dayLabel(day, today).toLowerCase()}. Add a task below.</div>
            ) : (
              STATUS_ORDER.filter((s) => grouped[s].length > 0).map((s) => (
                <div className="tk-group" key={s}>
                  <div className={`tk-group-head ${s}`}>
                    {STATUS_LABEL[s]} <span className="tk-group-n">{grouped[s].length}</span>
                  </div>
                  {grouped[s].map(taskRow)}
                </div>
              ))
            )}
          </div>
        </div>

        {/* Add bar */}
        <div className="tk-add">
          <input
            className="tk-add-text"
            placeholder={`Add a task for ${dayLabel(day, today).toLowerCase()}…`}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && void add()}
          />
          <select className="voice-select" value={draftPriority} onChange={(e) => setDraftPriority(e.target.value)} title="Priority">
            {PRIORITIES.map((p) => (
              <option key={p || 'none'} value={p}>
                {p || 'priority'}
              </option>
            ))}
          </select>
          <input
            className="tk-add-proj"
            placeholder="project"
            value={draftProject}
            onChange={(e) => setDraftProject(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && void add()}
          />
          <button className="cal-save" onClick={() => void add()} disabled={!draft.trim()}>
            <Plus size={14} /> Add
          </button>
        </div>

        {openCount > 0 && <div className="tk-foot">{openCount} open · {grouped.done.length} done</div>}
      </div>
    </div>
  )
}
