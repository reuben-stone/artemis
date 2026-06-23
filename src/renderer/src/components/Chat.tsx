import { useRef, useState, useEffect } from 'react'

export interface Message {
  role: 'user' | 'assistant'
  text: string
}

export default function Chat({
  messages,
  busy,
  voiceOn,
  onToggleVoice,
  onSend
}: {
  messages: Message[]
  busy: boolean
  voiceOn: boolean
  onToggleVoice: () => void
  onSend: (text: string) => void
}) {
  const [draft, setDraft] = useState('')
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' })
  }, [messages])

  const submit = () => {
    const text = draft.trim()
    if (!text || busy) return
    onSend(text)
    setDraft('')
  }

  return (
    <div className="chat">
      <div className="chat-log" ref={scrollRef}>
        {messages.length === 0 && (
          <div className="chat-empty">Ask Artemis to operate on your projects…</div>
        )}
        {messages.map((m, i) => (
          <div key={i} className={`bubble ${m.role}`}>
            {m.text}
          </div>
        ))}
      </div>
      <div className="chat-input">
        <button
          className={`voice-toggle ${voiceOn ? 'on' : ''}`}
          onClick={onToggleVoice}
          title={voiceOn ? 'Voice on' : 'Voice off'}
        >
          {voiceOn ? '🔊' : '🔇'}
        </button>
        <textarea
          value={draft}
          placeholder="Message Artemis…"
          rows={1}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              submit()
            }
          }}
        />
        <button className="send" onClick={submit} disabled={busy || !draft.trim()}>
          {busy ? '…' : '↑'}
        </button>
      </div>
    </div>
  )
}
