import { useRef, useState, useCallback, useEffect } from 'react'
import Orb, { type OrbState } from './components/Orb'
import TerminalPane from './components/TerminalPane'
import Chat, { type Message } from './components/Chat'
import PermissionDialog, { type PermissionReq } from './components/PermissionDialog'
import KeySetup from './components/KeySetup'
import { useVoice } from './hooks/useVoice'
import { NAME } from './agent/identity'
import { splitSpeech, speechFallback } from './agent/speech'

// The transcript lives in the durable SQLite backbone (main process), so it survives
// both a renderer hot-reload and a full restart — and isn't capped by localStorage's
// ~5MB quota. The renderer commits its own messages (user input, greeting,
// remember-acks); the operator commits assistant replies from main.

export default function App() {
  const [state, setState] = useState<OrbState>('idle')
  const [messages, setMessages] = useState<Message[]>([])
  const [busy, setBusy] = useState(false)
  const [voiceOn, setVoiceOn] = useState(true)
  const [showTerminal, setShowTerminal] = useState(false) // hidden until toggled
  const [autoLaunch, setAutoLaunch] = useState(false) // defaults off
  const [needsKey, setNeedsKey] = useState(false)
  const [permission, setPermission] = useState<PermissionReq | null>(null)

  const amplitudeRef = useRef(0)
  const { speak, cancel, voices, selectedVoice, setVoice, previewVoice } = useVoice(
    amplitudeRef,
    (speaking) => {
      if (speaking) setState('speaking')
    }
  )

  // refs so the (once-mounted) agent event listener never reads stale state
  const voiceOnRef = useRef(voiceOn)
  voiceOnRef.current = voiceOn
  const activeReq = useRef<string | null>(null)
  const acc = useRef('')
  const reqCounter = useRef(0)
  // Tokens arrive faster than we want to re-render markdown; coalesce a burst into
  // a single paint per animation frame so the transcript streams smoothly.
  const flushRaf = useRef<number | null>(null)

  const flushStream = useCallback(() => {
    flushRaf.current = null
    const display = splitSpeech(acc.current).display
    setMessages((m) => {
      const next = [...m]
      next[next.length - 1] = { role: 'assistant', text: display }
      return next
    })
  }, [])

  const cancelFlush = useCallback(() => {
    if (flushRaf.current != null) {
      cancelAnimationFrame(flushRaf.current)
      flushRaf.current = null
    }
  }, [])

  // auth: subscription-first. Only force key setup if neither is present.
  useEffect(() => {
    window.artemis?.auth?.status().then(({ hasSubscription, hasKey }) => {
      setNeedsKey(!hasSubscription && !hasKey)
    })
  }, [])

  useEffect(() => {
    window.artemis?.app?.getAutoLaunch().then(setAutoLaunch)
  }, [])

  // Restore the transcript from the SQLite backbone; only greet on a genuinely fresh
  // start. Then reattach to any turn that was in flight when we (re)loaded.
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      const restored = (await window.artemis?.history?.load()) ?? []
      if (cancelled) return
      if (restored.length) {
        setMessages(restored as Message[])
        reattachInFlight()
        return
      }

      // One-time cutover: import a pre-SQLite localStorage transcript so the switch
      // to the new backbone doesn't wipe an existing conversation. Runs once, then
      // clears the old key.
      try {
        const raw = localStorage.getItem('artemis.transcript.v1')
        const parsed = raw ? JSON.parse(raw) : null
        if (Array.isArray(parsed) && parsed.length) {
          for (const msg of parsed) {
            if (msg?.role && typeof msg.text === 'string') {
              await window.artemis?.history?.append(msg.role, msg.text)
            }
          }
          localStorage.removeItem('artemis.transcript.v1')
          if (cancelled) return
          setMessages(parsed as Message[])
          reattachInFlight()
          return
        }
      } catch {
        // corrupt/absent old store — fall through to a fresh greeting
      }

      const { facts } = (await window.artemis?.memory?.load()) ?? { facts: [] }
      if (cancelled) return
      const greeting =
        facts.length > 0
          ? `Welcome back. I'm ${NAME} — I remember ${facts.length} thing${
              facts.length === 1 ? '' : 's'
            } from past sessions. What are we working on?`
          : `I'm ${NAME}, your operator. I run on your Claude subscription and can read, edit, and rebuild my own code. What should we do?`
      setMessages([{ role: 'assistant', text: greeting }])
      window.artemis?.history?.append('assistant', greeting)
      if (voiceOnRef.current) setTimeout(() => speak(greeting), 400)
    })()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // If a turn was streaming when the renderer reloaded, the main process kept it
  // alive — re-adopt its requestId so events flow again and recover what we missed.
  const reattachInFlight = useCallback(() => {
    window.artemis?.agent?.resync().then((turn) => {
      if (!turn) return
      acc.current = turn.text
      activeReq.current = turn.requestId
      const text = turn.error
        ? `⚠️ ${turn.error}`
        : turn.done ?? splitSpeech(turn.text).display
      setMessages((m) => {
        const next = [...m]
        const last = next[next.length - 1]
        if (last && last.role === 'assistant') next[next.length - 1] = { role: 'assistant', text }
        else next.push({ role: 'assistant', text })
        return next
      })
      if (turn.done !== null || turn.error !== null) {
        // turn already finished mid-reload — settle the UI
        activeReq.current = null
        setBusy(false)
        setState(turn.error ? 'error' : 'idle')
      } else {
        // still streaming — keep busy and let the event listener carry it home
        setBusy(true)
        setState((turn.state as OrbState) || 'thinking')
      }
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // single subscription to the operator's event stream
  useEffect(() => {
    const off = window.artemis?.agent?.onEvent((e) => {
      if (e.requestId !== activeReq.current) return
      if (e.state) setState(e.state as OrbState)
      if (e.token) {
        acc.current += e.token
        if (flushRaf.current == null) flushRaf.current = requestAnimationFrame(flushStream)
      }
      if (e.done !== undefined) {
        cancelFlush()
        // `e.done` is already marker-stripped by main; acc may still hold the raw
        // stream, so derive both display and spoken line defensively.
        const display = e.done || splitSpeech(acc.current).display
        const spoken = e.speech || splitSpeech(acc.current).speech || speechFallback(display)
        setMessages((m) => {
          const next = [...m]
          next[next.length - 1] = { role: 'assistant', text: display }
          return next
        })
        if (voiceOnRef.current && spoken) speak(spoken)
        else setState('idle')
        setBusy(false)
        activeReq.current = null
      }
      if (e.error) {
        cancelFlush()
        setMessages((m) => [...m, { role: 'assistant', text: `⚠️ ${e.error}` }])
        setState('error')
        setBusy(false)
        activeReq.current = null
        setTimeout(() => setState('idle'), 2500)
      }
    })
    return () => {
      off?.()
    }
  }, [speak, flushStream, cancelFlush])

  // permission requests from the operator's tool calls
  useEffect(() => {
    const off = window.artemis?.agent?.onPermission((req) => setPermission(req))
    return () => {
      off?.()
    }
  }, [])

  const respondPermission = (allow: boolean) => {
    if (permission) window.artemis?.agent?.respondPermission(permission.permId, allow)
    setPermission(null)
  }

  const send = useCallback(
    async (text: string) => {
      setBusy(true)

      // "remember …" → persist a durable fact via the markdown memory store.
      const mem = text.match(/^\s*remember(?:\s+that)?\s+(.+)/i)
      if (mem && window.artemis?.memory) {
        const fact = mem[1].trim()
        setMessages((m) => [...m, { role: 'user', text }])
        window.artemis?.history?.append('user', text)
        await window.artemis.memory.save({
          name: fact.split(/\s+/).slice(0, 6).join('-'),
          description: fact.slice(0, 80),
          type: 'user',
          body: fact
        })
        const ack = `Saved to memory — I'll remember that across sessions.`
        setMessages((m) => [...m, { role: 'assistant', text: ack }])
        window.artemis?.history?.append('assistant', ack)
        setState('idle')
        if (voiceOn) speak(ack)
        setBusy(false)
        return
      }

      // hand the turn to the real operator. Commit the user message now; the operator
      // commits its assistant reply from main when the turn completes.
      setMessages((m) => [...m, { role: 'user', text }, { role: 'assistant', text: '' }])
      window.artemis?.history?.append('user', text)
      acc.current = ''
      const requestId = `r${reqCounter.current++}`
      activeReq.current = requestId
      await window.artemis?.agent?.run(requestId, text)
    },
    [voiceOn, speak]
  )

  const toggleVoice = () => {
    setVoiceOn((v) => {
      if (v) cancel()
      return !v
    })
  }

  if (needsKey) {
    return <KeySetup onDone={() => setNeedsKey(false)} />
  }

  return (
    <div className="app">
      <header className="titlebar">
        <span className="brand">◈ ARTEMIS</span>
        <div className="titlebar-right">
          <button
            className={`term-toggle ${showTerminal ? 'on' : ''}`}
            onClick={() => setShowTerminal((v) => !v)}
            title={showTerminal ? 'Hide terminal' : 'Show terminal'}
          >
            {'>_'}
          </button>
          {voices.length > 0 && (
            <select
              className="voice-select"
              value={selectedVoice}
              onChange={(e) => {
                setVoice(e.target.value)
                previewVoice(e.target.value)
              }}
              title="Voice"
            >
              {voices.map((v) => (
                <option key={v} value={v}>
                  {v}
                </option>
              ))}
            </select>
          )}
          <button
            className={`login-toggle ${autoLaunch ? 'on' : ''}`}
            onClick={() => window.artemis?.app?.setAutoLaunch(!autoLaunch).then(setAutoLaunch)}
            title="Launch Artemis at login"
          >
            {autoLaunch ? '⏻ start at login: on' : '⏻ start at login: off'}
          </button>
          <span className={`status status-${state}`}>{state}</span>
        </div>
      </header>

      <div className="stage">
        <section className="orb-pane">
          <Orb state={state} amplitudeRef={amplitudeRef} />
        </section>
        <section className="side-col">
          {showTerminal && (
            <div className="term-pane">
              <div className="pane-label">
                TERMINAL
                <button
                  className="pane-close"
                  onClick={() => setShowTerminal(false)}
                  title="Hide terminal"
                >
                  ✕
                </button>
              </div>
              <TerminalPane />
            </div>
          )}
          <div className="chat-pane">
            <div className="pane-label">ARTEMIS</div>
            <Chat
              messages={messages}
              busy={busy}
              state={state}
              voiceOn={voiceOn}
              onToggleVoice={toggleVoice}
              onSend={send}
            />
          </div>
        </section>
      </div>

      {permission && (
        <PermissionDialog req={permission} onRespond={respondPermission} />
      )}
    </div>
  )
}
