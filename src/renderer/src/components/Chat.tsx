import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkBreaks from 'remark-breaks'
import type { OrbState } from './Orb'

export interface Message {
  role: 'user' | 'assistant'
  text: string
}

const STATE_LABEL: Record<OrbState, string> = {
  idle: 'Thinking',
  thinking: 'Thinking',
  executing: 'Working',
  speaking: 'Speaking',
  error: 'Error'
}

export default function Chat({
  messages,
  busy,
  state,
  voiceOn,
  onToggleVoice,
  onSend
}: {
  messages: Message[]
  busy: boolean
  state: OrbState
  voiceOn: boolean
  onToggleVoice: () => void
  onSend: (text: string) => void
}) {
  const [draft, setDraft] = useState('')
  const scrollRef = useRef<HTMLDivElement>(null)
  const taRef = useRef<HTMLTextAreaElement>(null)
  // whether the view is pinned to the bottom; when false the user has
  // scrolled up and we must NOT yank them back down mid-stream.
  const stick = useRef(true)
  const lastTouchY = useRef(0)
  const [showJump, setShowJump] = useState(false)

  const scrollToBottom = (behavior: ScrollBehavior = 'smooth') => {
    const el = scrollRef.current
    if (!el) return
    el.scrollTo({ top: el.scrollHeight, behavior })
    stick.current = true
    setShowJump(false)
  }

  // Follow new content only while pinned to the bottom. Instant ('auto') is
  // deliberate: a smooth catch-up animation emits its own scroll events trending
  // toward the bottom, which would re-pin the view right after the user scrolled
  // up. Instant follow emits a single event at the bottom and nothing to fight.
  useLayoutEffect(() => {
    if (stick.current) scrollToBottom('auto')
  }, [messages])

  // Detaching from the bottom is driven by user *intent* (an upward wheel/touch
  // gesture), not by scroll position. While streaming we re-pin every frame, so a
  // position-based check would undo a small upward scroll before it registered.
  // Re-attaching is position-based: once the user returns to the bottom, resume.
  const detachIfScrollingUp = (deltaY: number) => {
    if (deltaY < 0 && stick.current) {
      stick.current = false
      setShowJump(true)
    }
  }

  const onScroll = () => {
    const el = scrollRef.current
    if (!el) return
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight
    if (distance < 8) {
      // back at the bottom — resume following
      stick.current = true
      setShowJump(false)
    } else if (!stick.current) {
      setShowJump(true)
    }
  }

  // grow the textarea with its content, up to the CSS max-height
  useEffect(() => {
    const ta = taRef.current
    if (!ta) return
    ta.style.height = 'auto'
    ta.style.height = `${Math.min(ta.scrollHeight, 160)}px`
  }, [draft])

  const submit = () => {
    const text = draft.trim()
    if (!text || busy) return
    onSend(text)
    setDraft('')
    stick.current = true
    requestAnimationFrame(() => scrollToBottom('auto'))
  }

  const last = messages[messages.length - 1]
  const streaming = busy && last?.role === 'assistant'
  const awaiting = streaming && last.text.length === 0

  return (
    <div className="chat">
      <div
        className="chat-log"
        ref={scrollRef}
        onScroll={onScroll}
        onWheel={(e) => detachIfScrollingUp(e.deltaY)}
        onTouchStart={(e) => {
          lastTouchY.current = e.touches[0]?.clientY ?? 0
        }}
        onTouchMove={(e) => {
          const y = e.touches[0]?.clientY ?? 0
          // finger dragging down reveals earlier content (an upward scroll)
          detachIfScrollingUp(lastTouchY.current - y)
          lastTouchY.current = y
        }}
      >
        {messages.length === 0 && (
          <div className="chat-empty">Ask Artemis to operate on your projects…</div>
        )}
        {messages.map((m, i) => {
          const isLast = i === messages.length - 1
          const isStreamingBubble = isLast && streaming && m.role === 'assistant'
          if (isStreamingBubble && m.text.length === 0) return null // rendered as thinking row below
          return (
            <div key={i} className={`row ${m.role}`}>
              <div className="avatar">{m.role === 'user' ? 'You' : '◈'}</div>
              <div className={`bubble ${m.role}`}>
                {m.role === 'assistant' ? (
                  <div className="md">
                    <ReactMarkdown
                      remarkPlugins={[remarkGfm, remarkBreaks]}
                      components={mdComponents}
                    >
                      {m.text}
                    </ReactMarkdown>
                    {isStreamingBubble && <span className="caret" />}
                  </div>
                ) : (
                  m.text
                )}
              </div>
            </div>
          )
        })}

        {awaiting && (
          <div className="row assistant">
            <div className="avatar">◈</div>
            <div className="bubble assistant thinking">
              <span className="think-label">{STATE_LABEL[state] ?? 'Thinking'}</span>
              <span className="dots">
                <i></i>
                <i></i>
                <i></i>
              </span>
            </div>
          </div>
        )}
      </div>

      {showJump && (
        <button className="jump-bottom" onClick={() => scrollToBottom()} title="Jump to latest">
          ↓
        </button>
      )}

      <div className="chat-input">
        <button
          className={`voice-toggle ${voiceOn ? 'on' : ''}`}
          onClick={onToggleVoice}
          title={voiceOn ? 'Voice on' : 'Voice off'}
        >
          {voiceOn ? '🔊' : '🔇'}
        </button>
        <textarea
          ref={taRef}
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

/* ---- markdown renderers ---- */

function CodeBlock({ code, lang }: { code: string; lang?: string }) {
  const [copied, setCopied] = useState(false)
  const copy = () => {
    navigator.clipboard?.writeText(code).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1400)
    })
  }
  return (
    <div className="code-block">
      <div className="code-head">
        <span className="code-lang">{lang || 'text'}</span>
        <button className="code-copy" onClick={copy}>
          {copied ? 'copied' : 'copy'}
        </button>
      </div>
      <pre>
        <code>{code}</code>
      </pre>
    </div>
  )
}

const mdComponents = {
  // unwrap <pre> so our CodeBlock owns the block layout (no invalid nesting)
  pre: ({ children }: any) => <>{children}</>,
  code: ({ className, children, ...props }: any) => {
    const text = String(children ?? '')
    const match = /language-(\w+)/.exec(className || '')
    const isBlock = !!match || text.includes('\n')
    if (!isBlock) {
      return (
        <code className="md-inline" {...props}>
          {children}
        </code>
      )
    }
    return <CodeBlock code={text.replace(/\n$/, '')} lang={match?.[1]} />
  },
  a: ({ children, href }: any) => (
    <a href={href} target="_blank" rel="noreferrer">
      {children}
    </a>
  )
}
