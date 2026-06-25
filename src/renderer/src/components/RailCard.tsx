import { ChevronDown, ChevronRight, GripVertical } from 'lucide-react'
import type { ReactNode, DragEvent as ReactDragEvent } from 'react'

export interface RailReorder {
  onDragStart: () => void
  onDragEnd: () => void
  onDragOver: (e: ReactDragEvent) => void
  onDrop: () => void
  dragging: boolean
  dragOver: boolean
}

/**
 * A rail section wrapper: a clickable header that collapses/expands the card, an optional
 * actions slot, and an optional drag grip for reordering. Used by every HUD rail card so
 * collapse + reorder behave identically across PR Review / Ecosystem / Tickets / Calendar.
 */
export function RailCard({
  title,
  icon,
  collapsed,
  onToggleCollapse,
  actions,
  reorder,
  children
}: {
  title: ReactNode
  icon: ReactNode
  collapsed: boolean
  onToggleCollapse: () => void
  actions?: ReactNode
  reorder?: RailReorder
  children: ReactNode
}): JSX.Element {
  return (
    <section
      className={`hud-card ${collapsed ? 'is-collapsed' : ''} ${reorder?.dragging ? 'dragging' : ''} ${reorder?.dragOver ? 'drag-over' : ''}`}
      onDragOver={reorder?.onDragOver}
      onDrop={
        reorder
          ? (e) => {
              e.preventDefault()
              reorder.onDrop()
            }
          : undefined
      }
    >
      <div className="hud-card-head">
        {reorder && (
          <span
            className="hud-card-grip"
            draggable
            onDragStart={reorder.onDragStart}
            onDragEnd={reorder.onDragEnd}
            title="Drag to reorder"
          >
            <GripVertical size={12} />
          </span>
        )}
        <button className="hud-card-titlebtn" onClick={onToggleCollapse} title={collapsed ? 'Expand' : 'Collapse'}>
          {collapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
          <span className="hud-card-title">
            {icon} {title}
          </span>
        </button>
        {actions && <div className="hud-card-head-actions">{actions}</div>}
      </div>
      {!collapsed && children}
    </section>
  )
}
