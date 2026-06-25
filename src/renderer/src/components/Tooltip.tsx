import { useRef, useState, type ReactNode } from 'react'

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
  children
}: {
  content: ReactNode
  placement?: 'top' | 'bottom'
  align?: 'start' | 'center' | 'end'
  delay?: number
  children: ReactNode
}): JSX.Element {
  const [show, setShow] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const open = (): void => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => setShow(true), delay)
  }
  const close = (): void => {
    if (timer.current) clearTimeout(timer.current)
    setShow(false)
  }

  return (
    <span className="tip-wrap" onMouseEnter={open} onMouseLeave={close} onFocus={open} onBlur={close}>
      {children}
      {show && content != null && (
        <span className={`tip tip-${placement} tip-${align}`} role="tooltip">
          {content}
        </span>
      )}
    </span>
  )
}
