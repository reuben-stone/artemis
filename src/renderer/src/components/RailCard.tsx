import { ChevronDown, ChevronRight } from 'lucide-react'
import type { ReactNode } from 'react'

/**
 * A rail section wrapper: a clickable header that collapses/expands the card, with an
 * optional actions slot (refresh, expand-to-dock, etc.). Used by every HUD rail card so
 * collapse behaves identically across PR Review / Ecosystem / Tickets / Calendar.
 */
export function RailCard({
  title,
  icon,
  collapsed,
  onToggleCollapse,
  actions,
  children
}: {
  title: ReactNode
  icon: ReactNode
  collapsed: boolean
  onToggleCollapse: () => void
  actions?: ReactNode
  children: ReactNode
}): JSX.Element {
  return (
    <section className={`hud-card ${collapsed ? 'is-collapsed' : ''}`}>
      <div className="hud-card-head">
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
