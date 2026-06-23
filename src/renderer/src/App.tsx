import { useRef, useState, useCallback, useEffect } from 'react'
import Orb, { type OrbState } from './components/Orb'
import TerminalPane from './components/TerminalPane'
import Chat, { type Message } from './components/Chat'
import PermissionDialog, { type PermissionReq } from './components/PermissionDialog'
import KeySetup from './components/KeySetup'
import { useVoice } from './hooks/useVoice'
import { NAME } from './agent/identity'

export default function App() {
  const [state, setState] = useState<OrbState>('idle')
  const [messages, setMessages] = useState<Message[]>([])
  const [busy, setBusy] = useState(false)
  const [voiceOn, setVoiceOn] = useState(true)
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

  // auth: subscription-first. Only force key setup if neither is present.
  useEffect(() => {
    window.artemis?.auth?.status().then(({ hasSubscription, hasKey }) => {
      setNeedsKey(!hasSubscription && !hasKey)
    })
  }, [])

  useEffect(() => {
    window.artemis?.app?.getAutoLaunch().then(setAutoLaunch)
  }, [])

  // greet using persistent memory
  useEffect(() => {
    window.artemis?.memory?.load().then(({ facts }) => {
      const greeting =
        facts.length > 0
          ? `Welcome back. I'm ${NAME} — I remember ${facts.length} thing${
              facts.length === 1 ? '' : 's'
            } from past sessions. What are we working on?`
          : `I'm ${NAME}, your operator. I run on your Claude subscription and can read, edit, and rebuild my own code. What should we do?`
      setMessages([{ role: 'assistant', text: greeting }])
      if (voiceOnRef.current) setTimeout(() => speak(greeting), 400)
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
        setMessages((m) => {
          const next = [...m]
          next[next.length - 1] = { role: 'assistant', text: acc.current }
          return next
        })
      }
      if (e.done !== undefined) {
        const finalText = e.done || acc.current
        setMessages((m) => {
          const next = [...m]
          next[next.length - 1] = { role: 'assistant', text: finalText }
          return next
        })
        if (voiceOnRef.current && finalText) speak(finalText)
        else setState('idle')
        setBusy(false)
        activeReq.current = null
      }
      if (e.error) {
        setMessages((m) => [...m, { role: 'assistant', text: `⚠️ ${e.error}` }])
        setState('error')
        setBusy(false)
        activeReq.current = null
        setTimeout(() => setState('idle'), 2500)
      }
    })
    return off
  }, [speak])

  // permission requests from the operator's tool calls
  useEffect(() => {
    const off = window.artemis?.agent?.onPermission((req) => setPermission(req))
    return off
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
        await window.artemis.memory.save({
          name: fact.split(/\s+/).slice(0, 6).join('-'),
          description: fact.slice(0, 80),
          type: 'user',
          body: fact
        })
        const ack = `Saved to memory — I'll remember that across sessions.`
        setMessages((m) => [...m, { role: 'assistant', text: ack }])
        setState('idle')
        if (voiceOn) speak(ack)
        setBusy(false)
        return
      }

      // hand the turn to the real operator
      setMessages((m) => [...m, { role: 'user', text }, { role: 'assistant', text: '' }])
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
          <div className="term-pane">
            <div className="pane-label">TERMINAL</div>
            <TerminalPane />
          </div>
          <div className="chat-pane">
            <div className="pane-label">ARTEMIS</div>
            <Chat
              messages={messages}
              busy={busy}
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
