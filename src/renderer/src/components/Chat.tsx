import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { MouseEvent as ReactMouseEvent } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkBreaks from 'remark-breaks'
import {
  Hexagon,
  ArrowDown,
  ArrowUp,
  Volume2,
  VolumeX,
  Mic,
  CircleDot,
  ChevronRight,
  Loader2,
  Check,
  Ban,
  AlertTriangle,
  Terminal,
  FileText,
  FilePen,
  Search,
  Globe,
  Brain,
  Activity,
  Bot,
  Wrench
} from 'lucide-react'
import type { OrbState } from './Orb'

export interface ToolStep {
  id: string
  name: string
  input?: unknown
  status: 'running' | 'ok' | 'error' | 'denied'
  output?: string
}

export interface Message {
  role: 'user' | 'assistant'
  text: string
  /** Tool calls made during this assistant turn, shown as an activity timeline. */
  tools?: ToolStep[]
}

const STATE_LABEL: Record<OrbState, string> = {
  idle: 'Thinking',
  thinking: 'Thinking',
  executing: 'Working',
  speaking: 'Speaking',
  listening: 'Listening',
  error: 'Error'
}

export default function Chat({
  messages,
  busy,
  state,
  voiceOn,
  onToggleVoice,
  onSend,
  onQueue,
  queueCount = 0,
  listening,
  micSupported,
  onMic,
  micHint
}: {
  messages: Message[]
  busy: boolean
  state: OrbState
  voiceOn: boolean
  onToggleVoice: () => void
  onSend: (text: string) => void
  onQueue?: (text: string) => void
  queueCount?: number
  listening: boolean
  micSupported: boolean
  onMic: () => void
  micHint?: string | null
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
    // Keep this cap in sync with the CSS max-height (.chat-input textarea); if the
    // JS cap exceeds it, max-height wins and the content overflows into a scrollbar.
    ta.style.height = `${Math.min(ta.scrollHeight, 120)}px`
  }, [draft])

  const submit = () => {
    const text = draft.trim()
    if (!text) return
    if (busy) {
      // Queue the message to be sent after the current turn completes.
      onQueue?.(text)
      setDraft('')
      return
    }
    onSend(text)
    setDraft('')
    stick.current = true
    requestAnimationFrame(() => scrollToBottom('auto'))
  }

  const last = messages[messages.length - 1]
  const streaming = busy && last?.role === 'assistant'
  // Show the "Thinking" row only before anything to show — once a tool starts (or text
  // streams), the bubble's timeline/text takes over.
  const awaiting = streaming && last.text.length === 0 && !last.tools?.length

  // Memoize the message bubbles so typing in the textarea (local `draft` state) does
  // NOT re-render the whole transcript through ReactMarkdown — the cause of the typing
  // lag on long conversations. Recomputes only when messages or streaming change.
  const renderedMessages = useMemo(
    () =>
      messages.map((m, i) => {
        const isLast = i === messages.length - 1
        const isStreamingBubble = isLast && streaming && m.role === 'assistant'
        // Only skip the empty streaming bubble when it has no tool activity yet — once a
        // tool is running we render the bubble to show the timeline.
        if (isStreamingBubble && m.text.length === 0 && !m.tools?.length) return null
        return (
          <div key={i} className={`row ${m.role}`}>
            <div className="avatar">{m.role === 'user' ? 'You' : <Hexagon size={13} />}</div>
            <div className={`bubble ${m.role}`}>
              {m.role === 'assistant' ? (
                <div className="md">
                  {m.tools && m.tools.length > 0 && <ToolTimeline steps={m.tools} />}
                  <ReactMarkdown
                    remarkPlugins={[remarkGfm, remarkBreaks]}
                    components={mdComponents}
                  >
                    {m.text}
                  </ReactMarkdown>
                  {isStreamingBubble && m.text.length > 0 && <span className="caret" />}
                </div>
              ) : (
                m.text
              )}
            </div>
          </div>
        )
      }),
    [messages, streaming]
  )

  // Clicking anywhere in the chat focuses the composer — unless the user is selecting
  // text or clicked an interactive element (link/button/the textarea itself).
  const focusComposer = (e: ReactMouseEvent): void => {
    if (window.getSelection()?.toString()) return
    if ((e.target as HTMLElement).closest('a, button, input, textarea')) return
    taRef.current?.focus()
  }

  return (
    <div className="chat" onClick={focusComposer}>
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
        {renderedMessages}

        {awaiting && (
          <div className="row assistant">
            <div className="avatar"><Hexagon size={13} /></div>
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
          <ArrowDown size={16} />
        </button>
      )}

      {micHint && <div className="mic-hint">{micHint}</div>}
      {queueCount > 0 && (
        <div className="queue-badge">{queueCount} queued</div>
      )}

      <div className="chat-input">
        <button
          className={`voice-toggle ${voiceOn ? 'on' : ''}`}
          onClick={onToggleVoice}
          title={voiceOn ? 'Voice on' : 'Voice off'}
        >
          {voiceOn ? <Volume2 size={16} /> : <VolumeX size={16} />}
        </button>
        {micSupported && (
          <button
            className={`mic-toggle ${listening ? 'on' : ''}`}
            onClick={onMic}
            title={listening ? 'Stop listening' : 'Speak to Artemis'}
          >
            {listening ? <CircleDot size={16} /> : <Mic size={16} />}
          </button>
        )}
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
        <button className="send" onClick={submit} disabled={!draft.trim()}>
          {busy && !draft.trim() ? '…' : <ArrowUp size={16} />}
        </button>
      </div>
    </div>
  )
}

/* ---- tool-call activity timeline ---- */

// Map a tool name to a glyph so the timeline scans at a glance.
function toolIcon(name: string): JSX.Element {
  switch (name) {
    case 'Read':
    case 'recall_memory':
      return <FileText size={12} />
    case 'Write':
    case 'Edit':
      return <FilePen size={12} />
    case 'Glob':
    case 'Grep':
      return <Search size={12} />
    case 'Bash':
      return <Terminal size={12} />
    case 'WebFetch':
      return <Globe size={12} />
    case 'save_memory':
      return <Brain size={12} />
    case 'ecosystem_status':
      return <Activity size={12} />
    case 'dispatch_worker':
      return <Bot size={12} />
    default:
      return <Wrench size={12} />
  }
}

function statusIcon(status: ToolStep['status']): JSX.Element {
  switch (status) {
    case 'running':
      return <Loader2 size={12} className="spin" />
    case 'error':
      return <AlertTriangle size={12} />
    case 'denied':
      return <Ban size={12} />
    default:
      return <Check size={12} />
  }
}

const tail = (p?: string): string => (p ? p.split('/').slice(-2).join('/') : '')

// A one-line summary of what the call is acting on (path / pattern / command…).
function argSummary(name: string, input: unknown): string {
  const i = (input ?? {}) as Record<string, unknown>
  const s = (v: unknown): string => (typeof v === 'string' ? v : '')
  switch (name) {
    case 'Read':
    case 'Write':
    case 'Edit':
      return tail(s(i.file_path))
    case 'Glob':
    case 'Grep':
      return s(i.pattern)
    case 'Bash':
      return s(i.description) || s(i.command)
    case 'WebFetch':
      return s(i.url)
    case 'save_memory':
      return s(i.name)
    case 'dispatch_worker':
      return s(i.project) ? `${s(i.project)} — ${s(i.task)}` : s(i.task)
    default:
      return ''
  }
}

function ToolTimeline({ steps }: { steps: ToolStep[] }): JSX.Element {
  return (
    <div className="tool-timeline">
      {steps.map((s) => (
        <ToolRow key={s.id} step={s} />
      ))}
    </div>
  )
}

function ToolRow({ step }: { step: ToolStep }): JSX.Element {
  const [open, setOpen] = useState(false)
  const summary = argSummary(step.name, step.input)
  const hasBody = !!(step.output || (step.input && Object.keys(step.input as object).length))
  return (
    <div className={`tool-row ${step.status}`}>
      <button className="tool-head" onClick={() => hasBody && setOpen((o) => !o)}>
        <span className={`tool-chev ${open ? 'open' : ''}`}>
          {hasBody ? <ChevronRight size={12} /> : <span className="tool-chev-gap" />}
        </span>
        <span className="tool-glyph">{toolIcon(step.name)}</span>
        <span className="tool-name">{step.name}</span>
        {summary && <span className="tool-arg">{summary}</span>}
        <span className={`tool-status ${step.status}`}>{statusIcon(step.status)}</span>
      </button>
      {open && hasBody && <ToolBody step={step} />}
    </div>
  )
}

function ToolBody({ step }: { step: ToolStep }): JSX.Element {
  const input = (step.input ?? {}) as Record<string, unknown>
  // Edits render as a red/green diff of the exact swap.
  if (step.name === 'Edit' && typeof input.old_string === 'string') {
    return (
      <div className="tool-body">
        <div className="tool-diff">
          <pre className="diff-del">{input.old_string as string}</pre>
          <pre className="diff-add">{String(input.new_string ?? '')}</pre>
        </div>
      </div>
    )
  }
  if (step.name === 'Write' && typeof input.content === 'string') {
    return (
      <div className="tool-body">
        <pre className="tool-out">{(input.content as string).slice(0, 2000)}</pre>
      </div>
    )
  }
  return (
    <div className="tool-body">
      {step.name === 'Bash' && typeof input.command === 'string' && (
        <pre className="tool-cmd">$ {input.command}</pre>
      )}
      {step.output && <pre className="tool-out">{step.output}</pre>}
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
