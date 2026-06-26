import { useCallback, useEffect, useState } from 'react'
import { X, MessageSquare, Volume2, Check, Send, CircleX, ExternalLink } from 'lucide-react'
import type { CommentNotification } from '../../../preload'

/**
 * The full Notifications surface — new (unread) comments across watched GitHub Projects boards,
 * in a roomy modal (the rail card's bigger sibling). Reply inline, mark all read, or have Artemis
 * read them aloud. Same data the rail card and the agent's notifications_view tool read, so they
 * never diverge; refreshSignal re-pulls when a turn settles (act-then-show).
 */
function relTime(ms: number): string {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000))
  if (s < 60) return 'just now'
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.round(m / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.round(h / 24)}d ago`
}

export function NotificationsView({
  refreshSignal,
  onSpeak,
  onChanged,
  onClose
}: {
  refreshSignal?: number
  onSpeak: (text: string) => void
  onChanged: () => void
  onClose: () => void
}): JSX.Element {
  const [notifs, setNotifs] = useState<CommentNotification[]>([])
  const [replyKey, setReplyKey] = useState<string | null>(null)
  const [replyText, setReplyText] = useState('')
  const [replying, setReplying] = useState(false)

  const key = (n: CommentNotification): string => `${n.project}#${n.issueNumber}@${n.createdAt}`

  const load = useCallback(async () => {
    const list = await window.artemis?.notifications?.list()
    if (list) setNotifs(list)
  }, [])

  useEffect(() => {
    void load()
  }, [load])
  useEffect(() => {
    if (refreshSignal !== undefined) void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshSignal])

  const markAllRead = useCallback(async () => {
    const updated = await window.artemis?.notifications?.markRead()
    if (updated) setNotifs(updated)
    onChanged()
  }, [onChanged])

  const reply = useCallback(
    async (n: CommentNotification) => {
      if (!replyText.trim() || n.issueNumber == null) return
      setReplying(true)
      try {
        const res = await window.artemis?.tickets?.comment({
          project: n.project,
          repo: n.repo,
          number: n.issueNumber,
          body: replyText.trim()
        })
        if (res?.ok) {
          setReplyKey(null)
          setReplyText('')
          await load()
          onChanged()
        }
      } finally {
        setReplying(false)
      }
    },
    [replyText, load, onChanged]
  )

  const readAloud = useCallback(() => {
    if (!notifs.length) {
      onSpeak('No new comments on your boards.')
      return
    }
    const top = notifs.slice(0, 5)
    const lines = top.map((n) => `${n.author} on ticket ${n.issueNumber}: ${n.body.replace(/\s+/g, ' ').slice(0, 200)}`)
    const more = notifs.length > top.length ? ` And ${notifs.length - top.length} more.` : ''
    onSpeak(`${notifs.length} new comment${notifs.length === 1 ? '' : 's'} on your boards. ${lines.join('. ')}.${more}`)
  }, [notifs, onSpeak])

  return (
    <div className="projects-overlay" onClick={onClose}>
      <div className="projects-panel notif-modal" onClick={(e) => e.stopPropagation()}>
        <div className="projects-head">
          <span>
            <MessageSquare size={14} /> NOTIFICATIONS{notifs.length ? ` · ${notifs.length}` : ''}
          </span>
          <div className="notif-head-actions">
            <button onClick={readAloud} disabled={!notifs.length} title="Read new comments aloud">
              <Volume2 size={14} />
            </button>
            <button onClick={() => void markAllRead()} disabled={!notifs.length} title="Mark all read">
              <Check size={14} />
            </button>
          </div>
          <button className="projects-close" onClick={onClose} title="Close">
            <X size={14} />
          </button>
        </div>

        <div className="notif-body">
          {notifs.length === 0 && <div className="notif-empty">No new comments. Sync a board to check for more.</div>}
          {notifs.map((n) => {
            const k = key(n)
            return (
              <div key={k} className="notif-item">
                <div className="notif-item-head">
                  <span className="notif-item-author">{n.author}</span>
                  <span className="notif-item-meta">
                    {n.boardTitle ? `${n.boardTitle} ` : ''}#{n.issueNumber} · {relTime(n.createdAt)}
                  </span>
                  <span className="notif-spacer" />
                  {n.url && (
                    <a className="notif-link" href={n.url} target="_blank" rel="noreferrer" title="Open the ticket on GitHub">
                      GitHub <ExternalLink size={11} />
                    </a>
                  )}
                </div>
                <div className="notif-item-title">{n.ticketTitle}</div>
                <div className="notif-item-body">{n.body.replace(/\s+/g, ' ')}</div>
                {replyKey === k ? (
                  <div className="notif-reply">
                    <textarea
                      value={replyText}
                      onChange={(e) => setReplyText(e.target.value)}
                      rows={2}
                      placeholder="Reply…"
                      autoFocus
                    />
                    <div className="notif-reply-actions">
                      <button className="cal-save" disabled={replying || !replyText.trim()} onClick={() => void reply(n)}>
                        <Send size={13} /> {replying ? 'Posting…' : 'Reply'}
                      </button>
                      <button className="cal-cancel" disabled={replying} onClick={() => setReplyKey(null)}>
                        <CircleX size={13} /> Cancel
                      </button>
                    </div>
                  </div>
                ) : (
                  <button
                    className="notif-replybtn"
                    onClick={() => {
                      setReplyKey(k)
                      setReplyText('')
                    }}
                  >
                    Reply
                  </button>
                )}
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
