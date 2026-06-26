import { useCallback, useEffect, useMemo, useState } from 'react'
import { X, CalendarDays, CalendarRange, ChevronLeft, ChevronRight, Plus, Trash2 } from 'lucide-react'
import type { CalendarEvent } from '../../../preload'

/**
 * A proper calendar surface — a roomy modal opened from the HUD rail. Two tabs share one
 * add/edit form: a Month grid (event dots, click a day to focus it) for scanning ahead, and
 * an Agenda list (upcoming, grouped by day) for "what's next". Reads/writes the same local
 * calendar Artemis CRUDs via its tools, so the two never diverge; onChanged refreshes the rail.
 */
const WEEKDAYS = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su']
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
const AGENDA_DAYS = 60

/** Local 'YYYY-MM-DD' (not UTC) — the planner is wall-clock local. */
function ymd(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
function parseYmd(s: string): Date {
  return new Date(`${s}T12:00:00`) // noon anchor — never trips DST
}
function prettyDay(s: string): string {
  return parseYmd(s).toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' })
}

type Draft = { id?: number; day: string; title: string; starts: string; ends: string; notes: string }

export function CalendarView({
  initialDay,
  refreshSignal,
  onChanged,
  onClose
}: {
  initialDay?: string | null // open focused on this day (e.g. from show_panel calendar day:…)
  refreshSignal?: number // bumps when a turn settles → refetch so agent edits show live
  onChanged: () => void
  onClose: () => void
}): JSX.Element {
  const today = ymd(new Date())
  const [tab, setTab] = useState<'month' | 'agenda'>('month')
  const [cursor, setCursor] = useState(() => {
    const d = initialDay ? parseYmd(initialDay) : new Date()
    return { y: d.getFullYear(), m: d.getMonth() }
  })
  const [selected, setSelected] = useState(initialDay || today)
  const [events, setEvents] = useState<CalendarEvent[]>([])
  const [draft, setDraft] = useState<Draft | null>(null)

  // The 42-cell (6-week) grid for the cursor month, weeks starting Monday.
  const grid = useMemo(() => {
    const first = new Date(cursor.y, cursor.m, 1)
    const lead = (first.getDay() + 6) % 7 // 0 = Monday
    return Array.from({ length: 42 }, (_, i) => new Date(cursor.y, cursor.m, 1 - lead + i))
  }, [cursor])

  const load = useCallback(async () => {
    const start = tab === 'month' ? ymd(grid[0]) : today
    const days = tab === 'month' ? 42 : AGENDA_DAYS
    const list = await window.artemis?.calendar?.list({ day: start, days })
    if (list) setEvents(list)
  }, [tab, grid, today])

  useEffect(() => {
    void load()
  }, [load])
  // Live refresh: when a turn settles (refreshSignal bumps), re-pull so events Artemis just
  // added/moved/removed appear in an already-open calendar — the "act-then-show" loop.
  useEffect(() => {
    if (refreshSignal !== undefined) void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshSignal])

  const byDay = useMemo(() => {
    const m: Record<string, CalendarEvent[]> = {}
    for (const e of events) (m[e.day] ??= []).push(e)
    return m
  }, [events])

  const save = useCallback(async () => {
    if (!draft || !draft.title.trim()) return
    const patch = {
      title: draft.title.trim(),
      day: draft.day,
      starts: draft.starts || null,
      ends: draft.ends || null,
      notes: draft.notes || null
    }
    if (draft.id) await window.artemis?.calendar?.update(draft.id, patch)
    else await window.artemis?.calendar?.add({ ...patch, title: patch.title })
    setDraft(null)
    await load()
    onChanged()
  }, [draft, load, onChanged])

  const remove = useCallback(
    async (id: number) => {
      await window.artemis?.calendar?.remove(id)
      setDraft(null)
      await load()
      onChanged()
    },
    [load, onChanged]
  )

  const newEvent = (day: string): void => setDraft({ day, title: '', starts: '', ends: '', notes: '' })
  const editEvent = (e: CalendarEvent): void =>
    setDraft({ id: e.id, day: e.day, title: e.title, starts: e.starts ?? '', ends: e.ends ?? '', notes: e.notes ?? '' })

  const shiftMonth = (delta: number): void =>
    setCursor((c) => {
      const d = new Date(c.y, c.m + delta, 1)
      return { y: d.getFullYear(), m: d.getMonth() }
    })

  const agendaDays = useMemo(
    () => Object.keys(byDay).filter((d) => d >= today).sort(),
    [byDay, today]
  )

  const eventRow = (e: CalendarEvent): JSX.Element => (
    <button key={e.id} className="cal-event" onClick={() => editEvent(e)} title="Edit">
      <span className="cal-event-when">{e.starts ? `${e.starts}${e.ends ? `–${e.ends}` : ''}` : 'all-day'}</span>
      <span className="cal-event-title">{e.title}</span>
      {e.source !== 'local' && <span className="cal-event-src">{e.source}</span>}
    </button>
  )

  return (
    <div className="projects-overlay" onClick={onClose}>
      <div className="projects-panel cal-modal" onClick={(e) => e.stopPropagation()}>
        <div className="projects-head">
          <span>
            <CalendarDays size={14} /> CALENDAR
          </span>
          <div className="cal-tabs">
            <button className={tab === 'month' ? 'on' : ''} onClick={() => setTab('month')}>
              <CalendarDays size={13} /> Month
            </button>
            <button className={tab === 'agenda' ? 'on' : ''} onClick={() => setTab('agenda')}>
              <CalendarRange size={13} /> Agenda
            </button>
          </div>
          <button className="projects-close" onClick={onClose} title="Close">
            <X size={14} />
          </button>
        </div>

        <div className="cal-body">
          <div className="cal-main">
            {tab === 'month' ? (
              <>
                <div className="cal-monthbar">
                  <button onClick={() => shiftMonth(-1)} title="Previous month">
                    <ChevronLeft size={16} />
                  </button>
                  <span className="cal-monthlabel">
                    {MONTHS[cursor.m]} {cursor.y}
                  </span>
                  <button onClick={() => shiftMonth(1)} title="Next month">
                    <ChevronRight size={16} />
                  </button>
                </div>
                <div className="cal-grid">
                  {WEEKDAYS.map((w) => (
                    <div key={w} className="cal-dow">
                      {w}
                    </div>
                  ))}
                  {grid.map((d) => {
                    const ds = ymd(d)
                    const inMonth = d.getMonth() === cursor.m
                    const has = byDay[ds]?.length ?? 0
                    return (
                      <button
                        key={ds}
                        className={`cal-cell ${inMonth ? '' : 'dim'} ${ds === selected ? 'sel' : ''} ${ds === today ? 'today' : ''}`}
                        onClick={() => {
                          setSelected(ds)
                          setDraft(null)
                        }}
                      >
                        <span className="cal-cell-num">{d.getDate()}</span>
                        {has > 0 && <span className="cal-cell-dot" title={`${has} event(s)`} />}
                      </button>
                    )
                  })}
                </div>
              </>
            ) : (
              <div className="cal-agenda">
                {agendaDays.length === 0 && <div className="cal-empty">No upcoming events in the next {AGENDA_DAYS} days.</div>}
                {agendaDays.map((d) => (
                  <div key={d} className="cal-agenda-day">
                    <div className={`cal-agenda-head ${d === today ? 'today' : ''}`}>{d === today ? 'Today · ' : ''}{prettyDay(d)}</div>
                    {byDay[d].map(eventRow)}
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Side panel: the selected day's events (month) + the shared add/edit form */}
          <div className="cal-side">
            {tab === 'month' && (
              <>
                <div className="cal-side-head">
                  <span>{prettyDay(selected)}</span>
                  <button className="cal-add" onClick={() => newEvent(selected)} title="Add event">
                    <Plus size={14} />
                  </button>
                </div>
                <div className="cal-side-list">
                  {(byDay[selected]?.length ?? 0) === 0 && !draft && <div className="cal-empty">No events. Add one →</div>}
                  {byDay[selected]?.map(eventRow)}
                </div>
              </>
            )}

            {tab === 'agenda' && !draft && (
              <button className="cal-add-wide" onClick={() => newEvent(today)}>
                <Plus size={14} /> New event
              </button>
            )}

            {draft && (
              <div className="cal-form">
                <div className="cal-form-title">{draft.id ? 'Edit event' : 'New event'}</div>
                <input
                  className="cal-in"
                  placeholder="Title"
                  value={draft.title}
                  autoFocus
                  onChange={(e) => setDraft({ ...draft, title: e.target.value })}
                  onKeyDown={(e) => e.key === 'Enter' && void save()}
                />
                <label className="cal-field">
                  <span>Day</span>
                  <input type="date" className="cal-in" value={draft.day} onChange={(e) => setDraft({ ...draft, day: e.target.value })} />
                </label>
                <div className="cal-times">
                  <label className="cal-field">
                    <span>Start</span>
                    <input type="time" className="cal-in" value={draft.starts} onChange={(e) => setDraft({ ...draft, starts: e.target.value })} />
                  </label>
                  <label className="cal-field">
                    <span>End</span>
                    <input type="time" className="cal-in" value={draft.ends} onChange={(e) => setDraft({ ...draft, ends: e.target.value })} />
                  </label>
                </div>
                <textarea
                  className="cal-in cal-notes"
                  placeholder="Notes (optional)"
                  value={draft.notes}
                  onChange={(e) => setDraft({ ...draft, notes: e.target.value })}
                />
                <div className="cal-form-actions">
                  {draft.id && (
                    <button className="cal-del" onClick={() => void remove(draft.id!)} title="Delete">
                      <Trash2 size={14} />
                    </button>
                  )}
                  <span className="cal-spacer" />
                  <button className="cal-cancel" onClick={() => setDraft(null)}>
                    Cancel
                  </button>
                  <button className="cal-save" onClick={() => void save()} disabled={!draft.title.trim()}>
                    {draft.id ? 'Save' : 'Add'}
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
