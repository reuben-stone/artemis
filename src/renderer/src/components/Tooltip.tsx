import { useLayoutEffect, useRef, useState, type ReactNode } from 'react'

/**
 * A styled hover/focus tooltip — replaces the OS-native `title=""` boxes with something
 * that matches the app. Reusable anywhere: wrap a trigger and pass `content` (string or
 * JSX). Placement is top/bottom; align handles edge triggers (e.g. a right-corner button
 * uses align="end" so the tip doesn't overflow the window).
 */
export function Tooltip({
  content,
  placement = 'bottom',
  align = 'center',
  delay = 350,
  className,
  children
}: {
  content: ReactNode
  placement?: 'top' | 'bottom'
  align?: 'start' | 'center' | 'end'
  delay?: number
  className?: string // merged onto the wrapper, so callers can position it (e.g. flex margin)
  children: ReactNode
}): JSX.Element {
  const [show, setShow] = useState(false)
  const [shift, setShift] = useState(0) // px nudge to keep the tip inside the window
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const tipRef = useRef<HTMLSpanElement>(null)

  const open = (): void => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => setShow(true), delay)
  }
  const close = (): void => {
    if (timer.current) clearTimeout(timer.current)
    setShow(false)
  }

  // After it shows, measure and nudge it horizontally so it never spills past the window edge
  // (e.g. a centered tip on a control near the right edge). Runs before paint — no flicker.
  useLayoutEffect(() => {
    if (!show) {
      setShift(0)
      return
    }
    const el = tipRef.current
    if (!el) return
    const pad = 8
    const r = el.getBoundingClientRect()
    if (r.right > window.innerWidth - pad) setShift(window.innerWidth - pad - r.right)
    else if (r.left < pad) setShift(pad - r.left)
  }, [show])

  return (
    <span className={`tip-wrap${className ? ` ${className}` : ''}`} onMouseEnter={open} onMouseLeave={close} onFocus={open} onBlur={close}>
      {children}
      {show && content != null && (
        <span
          ref={tipRef}
          className={`tip tip-${placement} tip-${align}`}
          role="tooltip"
          style={shift ? { marginLeft: shift } : undefined}
        >
          {content}
        </span>
      )}
    </span>
  )
}
