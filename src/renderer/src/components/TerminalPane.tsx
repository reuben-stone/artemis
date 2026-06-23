import { useEffect, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'

export default function TerminalPane() {
  const hostRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!hostRef.current) return
    const term = new Terminal({
      fontFamily: 'Menlo, Monaco, "SF Mono", monospace',
      fontSize: 12.5,
      cursorBlink: true,
      theme: {
        background: '#080a12',
        foreground: '#cdd6f4',
        cursor: '#9b6bff',
        selectionBackground: '#3aa0ff44'
      }
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(hostRef.current)
    fit.fit()

    const api = window.artemis?.terminal
    let disposed = false
    const offs: Array<() => void> = []

    if (api) {
      api.spawn({ cols: term.cols, rows: term.rows }).then((res) => {
        if (disposed) return
        if (!res?.ok) {
          term.writeln('\x1b[33m[artemis] terminal backend unavailable.\x1b[0m')
          term.writeln('\x1b[90m  node-pty failed to load — run: npm run postinstall\x1b[0m')
          return
        }
        offs.push(api.onData((d) => term.write(d)))
        offs.push(api.onExit(() => term.writeln('\r\n\x1b[90m[process exited]\x1b[0m')))
        term.onData((d) => api.write(d))
      })
    } else {
      term.writeln('\x1b[33m[artemis] not running inside Electron.\x1b[0m')
    }

    const onResize = () => {
      fit.fit()
      api?.resize({ cols: term.cols, rows: term.rows })
    }
    window.addEventListener('resize', onResize)

    return () => {
      disposed = true
      window.removeEventListener('resize', onResize)
      offs.forEach((off) => off())
      term.dispose()
    }
  }, [])

  return <div className="terminal-host" ref={hostRef} />
}
