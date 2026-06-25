import { useRef, useState, useCallback, useEffect } from 'react'
import Orb, { type OrbState } from './components/Orb'
import TerminalPane from './components/TerminalPane'
import Chat, { type Message, type OutMedia } from './components/Chat'
import PermissionDialog, { type PermissionReq } from './components/PermissionDialog'
import KeySetup from './components/KeySetup'
import { ProjectsPanel } from './components/ProjectsPanel'
import { PrReviewQueue } from './components/PrReviewQueue'
import { SettingsModal } from './components/SettingsModal'
import { BriefingCard } from './components/BriefingCard'
import { HudRail } from './components/HudRail'
import { CalendarView } from './components/CalendarView'
import { CommandPalette, type Command } from './components/CommandPalette'
import { Hexagon, FolderGit2, ChevronDown, MessageSquarePlus, GitPullRequest, Settings, X, Sunrise, Volume2, Terminal, Cpu, DollarSign, Shield, ShieldCheck, ShieldAlert } from 'lucide-react'
import type { Project, PrReview, GaProp, BriefingData, PermissionDecision, PermissionState } from '../../preload'
import { useVoice } from './hooks/useVoice'
import { useSpeech } from './hooks/useSpeech'
import { NAME } from './agent/identity'
import { splitSpeech, speechFallback } from './agent/speech'
import { transcribe, warmTranscriber } from './agent/transcribe'

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
  const [cost, setCost] = useState(0) // running session cost (USD)
  // Whether to surface the running cost estimate in the top bar. Off by default —
  // it's a niche metric (and goes to $0 once the local model is the brain). Persisted
  // as a pure UI preference in localStorage. Cost is always tracked; this only hides it.
  const [showCost, setShowCost] = useState(() => localStorage.getItem('artemis.showCost') === '1')
  const [micHint, setMicHint] = useState<string | null>(null)
  const [showUndo, setShowUndo] = useState(false) // "new conversation · Undo" toast
  const [model, setModel] = useState('claude-sonnet-4-6')
  // Multi-project foundation: the repos Artemis oversees + the panel toggle.
  const [projects, setProjects] = useState<Project[]>([])
  const [showProjects, setShowProjects] = useState(false)
  const [projectsBusy, setProjectsBusy] = useState(false)
  // PR Review Queue — worker-agent PRs awaiting approval.
  const [prs, setPrs] = useState<PrReview[]>([])
  const [showPrs, setShowPrs] = useState(false)
  const [showSettings, setShowSettings] = useState(false)
  const [showCmdk, setShowCmdk] = useState(false) // ⌘K command palette
  // On-command briefing, shown in a docked card in the orb area.
  const [showBriefing, setShowBriefing] = useState(false)
  const [briefingData, setBriefingData] = useState<BriefingData | null>(null)
  const [briefingLoading, setBriefingLoading] = useState(false)
  // Bumped each time a turn settles so the HUD rail refetches — Artemis may have
  // CRUD'd tickets/events via its tools during the turn.
  const [hudRefresh, setHudRefresh] = useState(0)
  const [showCalendar, setShowCalendar] = useState(false) // full calendar modal
  // Interactive permission posture: persisted mode (guarded/smart) + a session-only
  // "trusted" override. The effective state drives how many prompts you see.
  const [permMode, setPermMode] = useState<'guarded' | 'smart'>('smart')
  const [permTrusted, setPermTrusted] = useState(false)
  // Which brain runs turns: 'anthropic' (metered cloud) or 'ollama' (local / brain box).
  const [backend, setBackend] = useState('anthropic')
  const [ollamaHost, setOllamaHost] = useState('http://localhost:11434')
  const [ollamaModel, setOllamaModel] = useState('qwen2.5-coder:7b')

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

  // Text barge-in: messages typed while busy are held here and drained FIFO
  // after each turn completes. They never touch `messages` state until processed,
  // preserving the invariant that the last message is the streaming assistant bubble.
  const queueRef = useRef<string[]>([])
  const [queueCount, setQueueCount] = useState(0)
  // Keep latest `send` accessible inside the onEvent closure without adding it as a dep.
  // (send's identity changes when voiceOn/speak change; a ref always has the current one.)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sendRef = useRef<(text: string) => Promise<void>>(null as any)
  // Latest agent-driven-UI handler, so the once-mounted event listener always calls the
  // current closure (which captures the current open* handlers).
  const uiPanelRef = useRef<(ui: { panel?: string; project?: string }) => void>(() => {})
  // Tokens arrive faster than we want to re-render markdown; coalesce a burst into
  // a single paint per animation frame so the transcript streams smoothly.
  const flushRaf = useRef<number | null>(null)
  // Auto-dismiss timer for the new-conversation Undo toast.
  const undoTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const flushStream = useCallback(() => {
    flushRaf.current = null
    const display = splitSpeech(acc.current).display
    setMessages((m) => {
      const next = [...m]
      // Spread the prior bubble so the tool-activity timeline isn't wiped on each flush.
      next[next.length - 1] = { ...next[next.length - 1], role: 'assistant', text: display }
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

  useEffect(() => {
    window.artemis?.agent?.getModel().then((m) => m && setModel(m))
  }, [])

  // Toggle between the fast/cheap default (Sonnet) and max-capability (Opus). Takes
  // effect on the next turn — the agent reads the stored preference each turn.
  const toggleModel = useCallback(() => {
    setModel((m) => {
      const next = m === 'claude-opus-4-8' ? 'claude-sonnet-4-6' : 'claude-opus-4-8'
      window.artemis?.agent?.setModel(next)
      return next
    })
  }, [])

  useEffect(() => {
    window.artemis?.agent?.getBackendConfig().then((c) => {
      if (!c) return
      if (c.backend) setBackend(c.backend)
      if (c.ollamaHost) setOllamaHost(c.ollamaHost)
      if (c.ollamaModel) setOllamaModel(c.ollamaModel)
    })
  }, [])

  // Toggle the brain between cloud (Claude API) and local (Ollama). Like the model
  // toggle, it's read fresh each turn, so it takes effect on the next message.
  const toggleBackend = useCallback(() => {
    setBackend((b) => {
      const next = b === 'ollama' ? 'anthropic' : 'ollama'
      window.artemis?.agent?.setBackendConfig({ backend: next })
      return next
    })
  }, [])

  // Multi-project: load the registry on boot, and the add/remove/switch handlers.
  useEffect(() => {
    window.artemis?.projects?.list().then((p) => p && setProjects(p))
  }, [])

  const addProjects = useCallback(async () => {
    setProjectsBusy(true)
    try {
      const updated = await window.artemis?.projects?.add()
      if (updated) setProjects(updated)
    } finally {
      setProjectsBusy(false)
    }
  }, [])

  const removeProject = useCallback(async (id: number) => {
    const updated = await window.artemis?.projects?.remove(id)
    if (updated) setProjects(updated)
  }, [])

  const selectProject = useCallback(async (path: string) => {
    const updated = await window.artemis?.projects?.setActive(path)
    if (updated) setProjects(updated)
    setShowProjects(false)
  }, [])

  const activeProject = projects.find((p) => p.active)

  // PR Review Queue: load on boot, and the toggle/clear handlers.
  useEffect(() => {
    window.artemis?.prReviews?.list().then((p) => p && setPrs(p))
  }, [])

  const togglePr = useCallback(async (id: number, reviewed: boolean) => {
    const updated = await window.artemis?.prReviews?.setReviewed(id, reviewed)
    if (updated) setPrs(updated)
  }, [])

  const clearReviewedPrs = useCallback(async () => {
    const updated = await window.artemis?.prReviews?.clearReviewed()
    if (updated) setPrs(updated)
  }, [])

  // Refetch on open — worker agents add PRs in the main process during a turn, so the
  // renderer's cached list goes stale until we re-pull it.
  const openPrs = useCallback(async () => {
    const updated = await window.artemis?.prReviews?.list()
    if (updated) setPrs(updated)
    setShowPrs(true)
  }, [])

  const openProjects = useCallback(async () => {
    const updated = await window.artemis?.projects?.list()
    if (updated) setProjects(updated)
    setShowProjects(true)
  }, [])

  const openSettings = useCallback(async () => {
    const updated = await window.artemis?.projects?.list()
    if (updated) setProjects(updated)
    setShowSettings(true)
  }, [])

  const setGaProps = useCallback(async (path: string, props: GaProp[]) => {
    const updated = await window.artemis?.projects?.setGaProps(path, props)
    if (updated) setProjects(updated)
  }, [])

  // Settings handlers fed into the modal.
  const setOllama = useCallback((patch: { ollamaHost?: string; ollamaModel?: string }) => {
    if (patch.ollamaHost !== undefined) setOllamaHost(patch.ollamaHost)
    if (patch.ollamaModel !== undefined) setOllamaModel(patch.ollamaModel)
    window.artemis?.agent?.setBackendConfig(patch)
  }, [])

  const toggleAutoLaunch = useCallback(() => {
    window.artemis?.app?.setAutoLaunch(!autoLaunch).then(setAutoLaunch)
  }, [autoLaunch])

  const toggleTerminal = useCallback(() => setShowTerminal((v) => !v), [])

  const toggleShowCost = useCallback(() => {
    setShowCost((v) => {
      const next = !v
      localStorage.setItem('artemis.showCost', next ? '1' : '0')
      return next
    })
  }, [])

  // Stop the in-flight turn (Esc / Stop button) — aborts the model stream + tool loop
  // in main; the resulting `done` event settles the UI like a normal completion.
  const stopTurn = useCallback(() => {
    if (activeReq.current) window.artemis?.agent?.cancel(activeReq.current)
  }, [])

  // ⌘K toggles the command palette; Esc stops a running turn (unless the palette is
  // open, which handles its own Esc).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K')) {
        e.preventDefault()
        setShowCmdk((v) => !v)
      } else if (e.key === 'Escape' && !showCmdk && busy && activeReq.current) {
        e.preventDefault()
        stopTurn()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [showCmdk, busy, stopTurn])

  const pendingPrs = prs.filter((p) => !p.reviewed).length

  // Restore the transcript from the SQLite backbone; only greet on a genuinely fresh
  // start. Then reattach to any turn that was in flight when we (re)loaded.
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      const restored = (await window.artemis?.history?.load()) ?? []
      if (cancelled) return
      // A real conversation has at least one user message. Gate on that — NOT on
      // "non-empty" — because a prior boot may have seeded a lone auto-greeting,
      // which must not short-circuit the one-time migration below.
      if (restored.some((m) => m.role === 'user')) {
        setMessages(restored as Message[])
        reattachInFlight()
        return
      }

      // One-time cutover: import a pre-SQLite localStorage transcript so the switch
      // to the new backbone doesn't wipe an existing conversation. Only import if it
      // actually holds a conversation (a user message), then clear the old key.
      try {
        const raw = localStorage.getItem('artemis.transcript.v1')
        const parsed = raw ? JSON.parse(raw) : null
        if (Array.isArray(parsed) && parsed.some((m) => m?.role === 'user')) {
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

      // SQLite already held a lone auto-greeting (no user turn yet): keep it rather
      // than committing a duplicate greeting.
      if (restored.length) {
        setMessages(restored as Message[])
        return
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
      if (typeof e.cost === 'number') setCost((c) => c + e.cost!)
      if (e.ui) uiPanelRef.current(e.ui)
      if (e.tool) {
        const t = e.tool
        setMessages((m) => {
          const i = m.length - 1
          if (i < 0 || m[i].role !== 'assistant') return m
          const next = [...m]
          const msg = next[i]
          const tools = msg.tools ? [...msg.tools] : []
          if (t.phase === 'start') {
            tools.push({ id: t.id, name: t.name ?? 'tool', input: t.input, status: 'running' })
          } else {
            const j = tools.findIndex((s) => s.id === t.id)
            if (j >= 0) tools[j] = { ...tools[j], status: t.status ?? 'ok', output: t.output }
          }
          next[i] = { ...msg, tools }
          return next
        })
      }
      if (e.done !== undefined) {
        cancelFlush()
        // `e.done` is already marker-stripped by main; acc may still hold the raw
        // stream, so derive both display and spoken line defensively.
        const display = e.done || splitSpeech(acc.current).display
        const spoken = e.speech || splitSpeech(acc.current).speech || speechFallback(display)
        setMessages((m) => {
          const next = [...m]
          // Keep the completed turn's tool timeline alongside its final text.
          next[next.length - 1] = { ...next[next.length - 1], role: 'assistant', text: display }
          return next
        })
        if (voiceOnRef.current && spoken) speak(spoken)
        else setState('idle')
        setBusy(false)
        activeReq.current = null
        setHudRefresh((n) => n + 1) // turn done — pull any agent-side ticket/event edits
        // Drain one queued message. Defer by one tick so the completed turn
        // renders before the next one's empty assistant bubble appears.
        const next = queueRef.current.shift()
        if (next) {
          setQueueCount(queueRef.current.length)
          setTimeout(() => sendRef.current(next), 50)
        }
      }
      if (e.error) {
        cancelFlush()
        setMessages((m) => [...m, { role: 'assistant', text: `⚠️ ${e.error}` }])
        setState('error')
        setBusy(false)
        activeReq.current = null
        setTimeout(() => setState('idle'), 2500)
        // Still drain the queue after an error — the user's message shouldn't be lost.
        const next = queueRef.current.shift()
        if (next) {
          setQueueCount(queueRef.current.length)
          setTimeout(() => sendRef.current(next), 2600) // wait past the error state reset
        }
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

  const respondPermission = (decision: PermissionDecision) => {
    if (permission) window.artemis?.agent?.respondPermission(permission.permId, decision)
    setPermission(null)
  }

  // Load the permission posture on boot.
  useEffect(() => {
    window.artemis?.permissions?.get().then((s) => {
      if (!s) return
      setPermMode(s.mode)
      setPermTrusted(s.trusted)
    })
  }, [])

  // Cycle the posture: guarded → smart → trusted (session) → guarded. "Trusted" is
  // session-only (auto-approves all but hard-dangerous), so it's a separate flag.
  const effectivePerm: 'guarded' | 'smart' | 'trusted' = permTrusted ? 'trusted' : permMode
  const cyclePermission = useCallback(async () => {
    let next: PermissionState | undefined
    if (effectivePerm === 'guarded') next = await window.artemis?.permissions?.setMode('smart')
    else if (effectivePerm === 'smart') next = await window.artemis?.permissions?.setTrusted(true)
    else {
      await window.artemis?.permissions?.setTrusted(false)
      next = await window.artemis?.permissions?.setMode('guarded')
    }
    if (next) {
      setPermMode(next.mode)
      setPermTrusted(next.trusted)
    }
  }, [effectivePerm])

  const onQueue = useCallback((text: string) => {
    queueRef.current.push(text)
    setQueueCount(queueRef.current.length)
  }, [])

  const send = useCallback(
    async (text: string, media?: OutMedia[]) => {
      setBusy(true)

      // Memory intent is the model's job, not a UI keyword match: it has save_memory
      // / recall_memory tools and an accurate self-model, so it can tell "remember
      // that I prefer X" (save) from "remember any of our last convo?" (a recall
      // question) — a regex on "remember" cannot, and was false-saving questions.
      // hand the turn to the real operator. Show the user message optimistically; main
      // persists BOTH the user message (once) and its assistant reply when the turn
      // runs — committing it here too would double-send it into the model's context.
      setMessages((m) => [
        ...m,
        {
          role: 'user',
          text,
          images: media?.filter((i) => i.kind === 'image').map((i) => i.dataUrl),
          docs: media?.filter((i) => i.kind === 'document').map((i) => i.name)
        },
        { role: 'assistant', text: '' }
      ])
      acc.current = ''
      const requestId = `r${reqCounter.current++}`
      activeReq.current = requestId
      // Strip the display-only dataUrl/name before crossing IPC; main needs base64 + type.
      const payload = media?.map((i) => ({ kind: i.kind, mediaType: i.mediaType, data: i.data }))
      await window.artemis?.agent?.run(requestId, text, payload)
    },
    []
  )
  // Keep the ref current on every render so the onEvent drain always calls the
  // latest closure (which captures the current voiceOn / speak values).
  sendRef.current = send

  // On-command briefing → docked card (structured, gathered fresh).
  const runBriefingNow = useCallback(async () => {
    setBriefingLoading(true)
    try {
      const d = await window.artemis?.briefing?.data()
      if (d) setBriefingData(d)
    } finally {
      setBriefingLoading(false)
    }
  }, [])

  const openBriefing = useCallback(() => {
    setShowBriefing(true)
    if (!briefingData && !briefingLoading) void runBriefingNow()
  }, [briefingData, briefingLoading, runBriefingNow])

  // Agent-driven UI: open a panel / expand the rail / reflect a project switch that the
  // agent triggered via the show_panel or switch_project tool.
  const handleUi = useCallback(
    (ui: { panel?: string; project?: string }) => {
      switch (ui.panel) {
        case 'pr_queue':
          void openPrs()
          break
        case 'briefing':
          openBriefing()
          break
        case 'calendar':
          setShowCalendar(true)
          break
        case 'projects':
          void openProjects()
          break
        case 'settings':
          void openSettings()
          break
        case 'terminal':
          setShowTerminal(true)
          break
        case 'rail':
          window.dispatchEvent(new CustomEvent('artemis:hud', { detail: 'expand' }))
          break
      }
      // Agent switched the active project — refresh the registry so the titlebar +
      // projects panel reflect the new active highlight.
      if (ui.project) window.artemis?.projects?.list().then((p) => p && setProjects(p))
    },
    [openPrs, openBriefing, openProjects, openSettings]
  )
  uiPanelRef.current = handleUi

  // Voice input (Phase 1 — ears). Capture drives the orb amplitude from your live
  // voice; transcription is a swappable seam (agent/transcribe.ts). On a final
  // transcript we send it; until the Whisper engine is wired we show a gentle hint.
  const handleAudio = useCallback(
    async (samples: Float32Array, sampleRate: number) => {
      // The "downloads the model" note is only true the first time — the model is then
      // cached in the browser across restarts, so a localStorage flag mirrors that and we
      // drop the scary copy on every subsequent transcription.
      const warmed = localStorage.getItem('artemis.whisper.ready') === '1'
      setMicHint(warmed ? 'Transcribing…' : 'Transcribing… (first run downloads the model — can take a minute)')
      setState('thinking')
      const { text, error } = await transcribe(samples, sampleRate)
      setState('idle')
      if (text && text.trim()) {
        localStorage.setItem('artemis.whisper.ready', '1')
        setMicHint(null)
        send(text.trim())
      } else {
        // Leave terminal hints up long enough to read/report; errors longer.
        const msg = error ? `Transcription failed: ${error}` : "Didn't catch that — try again, or type."
        setMicHint(msg)
        window.setTimeout(() => setMicHint((h) => (h === msg ? null : h)), error ? 20000 : 6000)
      }
    },
    [send]
  )

  const speech = useSpeech(amplitudeRef, handleAudio)

  const toggleMic = useCallback(() => {
    if (speech.listening) speech.stop()
    else {
      cancel() // barge-in: stop any TTS so Artemis doesn't talk over you
      setMicHint(null)
      warmTranscriber() // preload Whisper now so the first transcription isn't slow
      void speech.start()
    }
  }, [speech, cancel])

  // Reflect listening in the orb; surface mic-capture errors (self-clearing). Note:
  // transcription hints are managed in handleAudio so the "Transcribing…" message is
  // not wiped while a slow first-time model download is still in flight.
  useEffect(() => {
    setState((s) => (speech.listening ? 'listening' : s === 'listening' ? 'idle' : s))
  }, [speech.listening])
  useEffect(() => {
    if (!speech.error) return
    const msg = speech.error
    setMicHint(msg)
    const id = window.setTimeout(() => setMicHint((h) => (h === msg ? null : h)), 8000)
    return () => window.clearTimeout(id)
  }, [speech.error])

  const toggleVoice = () => {
    setVoiceOn((v) => {
      if (v) cancel()
      return !v
    })
  }

  // New conversation: fresh SDK context + archived transcript view. History is kept
  // in the DB (the main process just raises the view floor), so nothing is lost —
  // which is why we offer an Undo toast instead of a blocking confirm dialog.
  const newConversation = useCallback(async () => {
    // In-flight guard: the one genuinely surprising case — starting fresh mid-turn
    // would orphan the running answer. Confirm before discarding it.
    if (busy && !window.confirm('Artemis is still responding — start a new conversation anyway?')) {
      return
    }
    // Only offer Undo if there was a real thread to archive (a user message).
    const hadThread = messages.some((m) => m.role === 'user')

    await window.artemis?.agent?.newConversation()
    cancel()
    cancelFlush()
    acc.current = ''
    activeReq.current = null
    setBusy(false)
    setState('idle')
    setCost(0)
    const greeting = `What can I help with?`
    setMessages([{ role: 'assistant', text: greeting }])
    window.artemis?.history?.append('assistant', greeting)
    if (voiceOnRef.current) setTimeout(() => speak(greeting), 200)

    if (hadThread) {
      setShowUndo(true)
      if (undoTimer.current) clearTimeout(undoTimer.current)
      undoTimer.current = setTimeout(() => setShowUndo(false), 6000)
    }
  }, [busy, messages, cancel, cancelFlush, speak])

  // Undo a new-conversation within the toast window: drop the fresh-start greeting
  // and restore the archived thread.
  const undoNewConversation = useCallback(async () => {
    if (undoTimer.current) clearTimeout(undoTimer.current)
    setShowUndo(false)
    cancel()
    await window.artemis?.agent?.undoNewConversation()
    const restored = (await window.artemis?.history?.load()) ?? []
    setMessages(restored as Message[])
    setState('idle')
  }, [cancel])

  // Command palette entries — every toolbar action plus quick project switching.
  const commands: Command[] = [
    { id: 'new', label: 'New chat', icon: <MessageSquarePlus size={15} />, run: () => void newConversation() },
    { id: 'briefing', label: 'Run ecosystem briefing', icon: <Sunrise size={15} />, run: openBriefing },
    { id: 'prs', label: 'PR review queue', icon: <GitPullRequest size={15} />, run: () => void openPrs() },
    { id: 'projects', label: 'Switch / manage projects', icon: <FolderGit2 size={15} />, run: () => void openProjects() },
    { id: 'settings', label: 'Open settings', icon: <Settings size={15} />, run: () => void openSettings() },
    { id: 'model', label: `Switch model to ${model === 'claude-opus-4-8' ? 'Sonnet' : 'Opus'}`, icon: <Cpu size={15} />, run: toggleModel },
    { id: 'voice', label: `${voiceOn ? 'Disable' : 'Enable'} voice`, icon: <Volume2 size={15} />, run: toggleVoice },
    { id: 'terminal', label: `${showTerminal ? 'Hide' : 'Show'} terminal pane`, icon: <Terminal size={15} />, run: toggleTerminal },
    { id: 'cost', label: `${showCost ? 'Hide' : 'Show'} cost in top bar`, icon: <DollarSign size={15} />, run: toggleShowCost },
    ...projects
      .filter((p) => !p.active)
      .map((p) => ({
        id: `proj-${p.id}`,
        label: `Switch to ${p.name}`,
        hint: 'project',
        icon: <FolderGit2 size={15} />,
        run: () => void selectProject(p.path)
      }))
  ]

  // Native menu items → same as the toolbar buttons.
  useEffect(() => {
    const off = window.artemis?.menu?.onNewChat(() => void newConversation())
    return () => off?.()
  }, [newConversation])
  useEffect(() => {
    const off = window.artemis?.menu?.onSettings(() => void openSettings())
    return () => off?.()
  }, [openSettings])

  if (needsKey) {
    return <KeySetup onDone={() => setNeedsKey(false)} />
  }

  return (
    <div className="app">
      <header className="titlebar">
        <span
          className="brand"
          title="A.R.T.E.M.I.S. — Autonomous Repository-Tending Engineering, Monitoring & Intelligence System"
        >
          <Hexagon size={14} strokeWidth={2.5} /> ARTEMIS
        </span>
        <div className="titlebar-right">
          {/* Left: context */}
          <button
            className={`project-switch ${activeProject && activeProject.name !== 'artemis (self)' ? 'on' : ''}`}
            onClick={() => (showProjects ? setShowProjects(false) : openProjects())}
            title="Switch / manage projects"
          >
            <FolderGit2 size={13} />
            <span className="btn-tag">PROJECT</span>
            {activeProject?.name ?? '—'}
            <ChevronDown size={12} className="btn-caret" />
          </button>
          <button
            className={`pr-queue-btn ${pendingPrs > 0 ? 'on' : ''}`}
            onClick={() => (showPrs ? setShowPrs(false) : openPrs())}
            title="PR review queue"
          >
            <GitPullRequest size={14} /> PRs{pendingPrs > 0 ? ` (${pendingPrs})` : ''}
          </button>
          <button
            className={`pr-queue-btn ${showBriefing ? 'on' : ''}`}
            onClick={() => (showBriefing ? setShowBriefing(false) : openBriefing())}
            title="Run / show the ecosystem briefing"
          >
            <Sunrise size={14} /> Briefing
          </button>

          <span className="titlebar-spacer" />

          {/* Right: primary action + settings + status */}
          <button
            className="new-convo"
            onClick={newConversation}
            title="Start a new conversation (keeps history)"
          >
            <MessageSquarePlus size={14} /> New chat
          </button>
          <button
            className={`perm-btn perm-${effectivePerm}`}
            onClick={() => void cyclePermission()}
            title={
              effectivePerm === 'guarded'
                ? 'Permissions: Guarded — Artemis asks before every command. Click for Smart.'
                : effectivePerm === 'smart'
                  ? 'Permissions: Smart — safe read-only commands run without asking. Click for Trusted (this session).'
                  : 'Permissions: Trusted (this session) — auto-runs everything except hard-dangerous commands. Click to return to Guarded.'
            }
          >
            {effectivePerm === 'guarded' ? <Shield size={14} /> : effectivePerm === 'smart' ? <ShieldCheck size={14} /> : <ShieldAlert size={14} />}
            <span className="btn-tag">{effectivePerm}</span>
          </button>
          <button
            className="conn-btn"
            onClick={() => (showSettings ? setShowSettings(false) : openSettings())}
            title="Settings"
          >
            <Settings size={15} />
          </button>

          {/* Status */}
          {showCost && cost > 0 && (
            <span className="cost" title="Estimated cost this conversation (list prices)">
              ${cost < 0.01 ? cost.toFixed(4) : cost.toFixed(3)}
            </span>
          )}
          <span className={`status status-${state}`}>{state}</span>
        </div>
      </header>

      <div className="stage">
        <section className="orb-pane">
          <HudRail
            refreshSignal={hudRefresh}
            onAsk={(p) => void send(p)}
            onOpenCalendar={() => setShowCalendar(true)}
            onOpenPrs={() => void openPrs()}
            onOpenBriefing={openBriefing}
          />
          <div className="orb-stage">
            <Orb state={state} amplitudeRef={amplitudeRef} />
            {showBriefing && (
              <div className="orb-dock">
                <BriefingCard
                  data={briefingData}
                  loading={briefingLoading}
                  onRefresh={runBriefingNow}
                  onClose={() => setShowBriefing(false)}
                />
              </div>
            )}
            {showPrs && (
              <div className="orb-dock-bottom">
                <PrReviewQueue
                  prs={prs}
                  onToggle={togglePr}
                  onClearReviewed={clearReviewedPrs}
                  onClose={() => setShowPrs(false)}
                />
              </div>
            )}
          </div>
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
                  <X size={13} />
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
              onQueue={onQueue}
              onStop={stopTurn}
              queueCount={queueCount}
              listening={speech.listening}
              micSupported={speech.supported}
              onMic={toggleMic}
              micHint={micHint}
            />
          </div>
        </section>
      </div>

      {permission && (
        <PermissionDialog req={permission} onRespond={respondPermission} />
      )}

      {showUndo && (
        <div className="undo-toast" role="status">
          <span>Started a new conversation</span>
          <button onClick={undoNewConversation}>Undo</button>
        </div>
      )}

      {showProjects && (
        <ProjectsPanel
          projects={projects}
          busy={projectsBusy}
          onAdd={addProjects}
          onRemove={removeProject}
          onSelect={selectProject}
          onClose={() => setShowProjects(false)}
        />
      )}

      {showCalendar && (
        <CalendarView onChanged={() => setHudRefresh((n) => n + 1)} onClose={() => setShowCalendar(false)} />
      )}

      {showCmdk && <CommandPalette commands={commands} onClose={() => setShowCmdk(false)} />}

      {showSettings && (
        <SettingsModal
          model={model}
          onToggleModel={toggleModel}
          backend={backend}
          onToggleBackend={toggleBackend}
          ollamaHost={ollamaHost}
          ollamaModel={ollamaModel}
          onSetOllama={setOllama}
          voices={voices}
          selectedVoice={selectedVoice}
          onSetVoice={setVoice}
          onPreviewVoice={previewVoice}
          autoLaunch={autoLaunch}
          onToggleAutoLaunch={toggleAutoLaunch}
          showTerminal={showTerminal}
          onToggleTerminal={toggleTerminal}
          showCost={showCost}
          onToggleShowCost={toggleShowCost}
          projects={projects}
          onSetGaProps={setGaProps}
          onClose={() => setShowSettings(false)}
        />
      )}
    </div>
  )
}
