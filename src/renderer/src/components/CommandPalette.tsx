import { useEffect, useMemo, useRef, useState } from 'react'

export interface Command {
  id: string
  label: string
  hint?: string
  icon?: JSX.Element
  run: () => void
}

/**
 * ⌘K command palette — keyboard-first access to every toolbar action plus quick
 * project switching. Renderer-only; App owns the open/close state and the command list.
 */
export function CommandPalette({
  commands,
  onClose
}: {
  commands: Command[]
  onClose: () => void
}): JSX.Element {
  const [q, setQ] = useState('')
  const [active, setActive] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  const filtered = useMemo(() => {
    const s = q.trim().toLowerCase()
    if (!s) return commands
    return commands.filter(
      (c) => c.label.toLowerCase().includes(s) || c.hint?.toLowerCase().includes(s)
    )
  }, [q, commands])

  // Reset the highlighted row whenever the filter changes so it never points past the list.
  useEffect(() => {
    setActive(0)
  }, [q])

  const run = (c?: Command): void => {
    if (!c) return
    onClose()
    c.run()
  }

  return (
    <div className="cmdk-overlay" onClick={onClose}>
      <div className="cmdk" onClick={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          className="cmdk-input"
          placeholder="Type a command…"
          value={q}
          spellCheck={false}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault()
              setActive((a) => Math.min(a + 1, filtered.length - 1))
            } else if (e.key === 'ArrowUp') {
              e.preventDefault()
              setActive((a) => Math.max(a - 1, 0))
            } else if (e.key === 'Enter') {
              e.preventDefault()
              run(filtered[active])
            } else if (e.key === 'Escape') {
              e.preventDefault()
              onClose()
            }
          }}
        />
        <div className="cmdk-list">
          {filtered.length === 0 && <div className="cmdk-empty">No matching commands</div>}
          {filtered.map((c, i) => (
            <button
              key={c.id}
              className={`cmdk-item ${i === active ? 'active' : ''}`}
              onMouseMove={() => setActive(i)}
              onClick={() => run(c)}
            >
              {c.icon && <span className="cmdk-icon">{c.icon}</span>}
              <span className="cmdk-label">{c.label}</span>
              {c.hint && <span className="cmdk-hint">{c.hint}</span>}
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}
